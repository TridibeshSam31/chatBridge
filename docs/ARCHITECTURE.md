# ChatBridge — Architecture

Status: revision 3 · 2026-11-03 · all phases implemented; decisions C2, C3 approved by the project owner.
At the owner's request, Phases 2–6 were built before real-session validation. Validating the
ChatGPT page and data structure against a real session is still **pending** (see §13). The export path
does not depend on it.

This document covers the twelve items requested before implementation. Where the
spec's assumptions do not hold up, it says so and proposes an alternative.

**Owner decisions (rev 2):**

1. Three extraction methods. The export is the reliable fallback, DOM is the normal path, and the
   internal endpoint is opt-in only. The internal endpoint is off by default, needs explicit
   consent, is labelled unsupported, is never essential, and never bypasses authentication.
2. Selectors must be validated against the owner's real session (with permission) or a sanitized
   saved page before the extractor is built. Unrelated conversations and credentials must not be
   collected.
3. The Side Panel is the primary UI. The Gemini API is used for continuation, kept clearly distinct
   from native gemini.google.com chats.
4. Cross-cutting rules: provider-independent; original transcript kept locally and **separately**
   from structured context; no silent truncation; extraction method and migration status always
   visible; reliable fallback between methods; integrity, security and reliability before polish.

---

## 0. Challenges to the specification (read first)

| #   | Spec assumption                                   | Reality                                                                                                                                                                                                                                                | Proposal                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | "Migrate the conversation to Gemini"              | gemini.google.com has **no public API for importing chat history**. A Gemini **API** chat is a separate product surface: it will not show up in the user's Gemini web history.                                                                         | The primary destination is a Gemini API chat that lives **inside ChatBridge** (in the side panel). The fallback is a _Smart Migration package_ that the user pastes or attaches into gemini.google.com. The UI must say plainly which one the user is getting.                                          |
| C2  | UI is a toolbar **popup**                         | A popup is destroyed whenever it loses focus. That breaks long extractions, kills any chat UI, and turns "user closes popup during extraction" into the normal case.                                                                                   | Use the **Chrome Side Panel** (`chrome.sidePanel`, Chrome ≥ 116). It stays open while the user works in the tab, and it can host the continued Gemini chat. Clicking the toolbar icon opens it. _(Implemented in Phase 1.)_                                                                             |
| C3  | DOM extraction + export JSON                      | DOM extraction only sees what has been rendered. The export is complete but can take hours to arrive by email, and it is a snapshot. ChatGPT's web app loads each conversation from an **internal endpoint** that returns the same tree as the export. | Keep DOM extraction and export import as specified. Optionally add **Method 3: the internal conversation endpoint**, read with the user's own logged-in session. It is complete and current, but undocumented: it can break without notice and sits in a ToS grey zone. **APPROVED, opt-in only** (§6). |
| C4  | "Prefer a secure backend proxy"                   | This is bring-your-own-key: the user pastes their own Gemini key. A proxy only helps if _we_ own the key, and then we would also be storing everyone's conversations, which contradicts local-first.                                                   | No proxy in the MVP. Document the risks of local key storage (§9). Revisit only if ChatBridge ever ships a hosted key.                                                                                                                                                                                  |
| C5  | "Do not send history as one enormous user prompt" | That is correct for the API path. For the **gemini.google.com** path it is the _only_ option, because the web composer has no notion of past turns.                                                                                                    | API path: real multi-turn `history`. Web path: a single structured document, clearly labelled as transcript data.                                                                                                                                                                                       |
| C6  | Context budget = model window                     | Gemini 2.x/3 windows are ≥ 1M tokens, so most chats "fit". The API is stateless, though, so **every new turn re-sends the whole history**. Cost and latency grow linearly, and answer quality drops on very long inputs.                               | The default _practical_ budget is far below the hard limit (e.g. 200k tokens, user-adjustable). Explicit context caching is a Phase 5 option for large histories.                                                                                                                                       |
| C7  | "Preserve behavioural instructions"               | The export includes the user's **Custom Instructions** (`content_type: user_editable_context`). The DOM never shows them. ChatGPT _memory_ is not exported per-conversation.                                                                           | Capture custom instructions as first-class preferences (with provenance "custom instructions") when importing from the export or Method 3. Tell the user that memory cannot be transferred.                                                                                                             |
| C8  | Context engine runs locally                       | The semantic (LLM) pass sends the conversation to Gemini. That is a transmission, and it needs consent.                                                                                                                                                | Two passes: a deterministic pass that is offline and always available, and an LLM pass that runs only behind an explicit consent gate (the same gate as migration).                                                                                                                                     |

---

## 1. Product architecture

```
            ┌──────────────── Sources (adapters) ────────────────┐
            │  ChatGPT DOM   │  ChatGPT export  │ (opt) internal  │
            └───────┬────────┴────────┬─────────┴───────┬─────────┘
                    └──────────► NormalizedConversation ◄┘
                                     │  (Zod-validated, provider-neutral)
                ┌────────────────────┼────────────────────┐
                ▼                    ▼                    ▼
         Context Engine       Token Manager        Local Store (IndexedDB)
   (deterministic + LLM)    (estimate, budget)    (transcripts, sessions)
                └────────────┬───────┘
                             ▼
                     Migration Planner  ──► MigrationPlan (what is included /
                             │                summarized / excluded, and why)
                             ▼
                 Destination adapters: Gemini API  │  Gemini web package
```

Concepts:

- **Source adapter**: produces a `NormalizedConversation` and an `ExtractionReport` (completeness, warnings).
- **Context profile**: structured, evidence-linked facts about the conversation.
- **Migration plan**: a pure, previewable description of what will be sent. Nothing is sent without one.
- **Destination adapter**: turns a plan into provider-specific payloads and runs the session.

Adding Claude later means writing one destination adapter (and maybe a source adapter). Core stays unchanged.

## 2. System architecture (Chrome runtime)

```
 chatgpt.com tab                         Extension
 ┌──────────────────────┐   runtime     ┌────────────────────────────┐
 │ Content script        │◄────────────►│ Side panel (React)          │
 │ (isolated world)      │  messages    │  - UI, consent, preview     │
 │ - detect conversation │  (Zod-typed) │  - runs Gemini calls        │
 │ - DOM extraction      │              │  - context engine (Worker)  │
 │ - (opt-in) endpoint   │              │  - export file import       │
 │ - structural probes   │              │  - diagnostics screen       │
 └──────────────────────┘              └─────────────┬──────────────┘
                                                     │
                                      ┌──────────────▼──────────────┐
                                      │ Service worker (MV3)         │
                                      │ - side panel behaviour       │
                                      │ - job state checkpoints      │
                                      │ - storage housekeeping       │
                                      └──────────────┬──────────────┘
                                                     ▼
                                     chrome.storage.local / IndexedDB
```

Why long work runs in the side panel and not the service worker: an MV3 worker is killed after about 30 s idle and its in-memory state is lost. The side panel page lives as long as it is open. Every multi-step job (extraction, LLM analysis, migration) writes **checkpoints** to IndexedDB, so a closed panel or a restarted worker resumes from the last checkpoint instead of starting over.

Permissions (minimal): `sidePanel`, `scripting` (inject into ChatGPT tabs opened before install), and from Phase 4 `storage`. Host permissions: `https://chatgpt.com/*` and `https://chat.openai.com/*`. From Phase 4 add `https://generativelanguage.googleapis.com/*`. Phase 1 adds no `tabs` and no `<all_urls>`.

## 3. Project structure

```
chatbridge/
├── manifest.json                 # source manifest (copied into dist by Vite)
├── sidepanel.html                # side panel entry
├── vite.config.ts                # pages + service worker (ES modules)
├── vite.content.config.ts        # content script (single IIFE, no imports)
├── vitest.config.ts · playwright.config.ts · eslint.config.js
├── docs/ARCHITECTURE.md
├── src/
│   ├── background/service-worker.ts
│   ├── content/chatgpt/
│   │   ├── index.ts              # entry: message listener
│   │   ├── adapter.ts            # detect + (Phase 2) extract → normalized
│   │   ├── selectors.ts          # every ChatGPT selector lives here
│   │   └── url.ts
│   ├── sidepanel/                # React UI (spec's "popup")
│   │   ├── App.tsx · main.tsx · styles.css · tab-bridge.ts
│   │   ├── components/ · pages/
│   ├── core/                     # Phase 2+: pure, platform-free logic
│   │   ├── conversation/         # schema helpers, dedupe, branch resolution
│   │   ├── import/chatgpt-export/
│   │   ├── context/              # deterministic + LLM passes
│   │   ├── token-management/
│   │   └── migration/            # planner
│   ├── providers/gemini/         # Phase 4: client, mapper, session
│   ├── storage/                  # Phase 2+: IndexedDB repos
│   └── shared/                   # message protocol, error codes, schemas
└── tests/
    ├── fixtures/ (chatgpt-dom/, chatgpt-export/)
    ├── unit/
    └── integration/  (Playwright, loads the built extension)
```

Deviation from the spec: `core/` and `providers/` hold no Chrome APIs, so they can be unit-tested without a browser. `schemas/` is folded into `shared/` until it grows.

## 4. Data flow

1. The side panel asks the active tab's content script to `detect` → it gets the conversation id, title, and count of rendered messages.
2. **Analyze**: the source adapter extracts → `NormalizedConversation` + `ExtractionReport`. Both are stored locally, and the user sees the report (complete / partial / unknown).
3. Deterministic context pass (local) → partial `ContextProfile`.
4. _(Consent gate #1)_ Optional LLM pass → full profile. Every item has evidence ids; items whose evidence does not resolve are dropped and counted.
5. The user picks a mode and budget → the planner produces a `MigrationPlan` → preview (included / summarized / excluded + reasons).
6. _(Consent gate #2)_ The Gemini adapter maps the plan → `chats.create({history, systemInstruction})`. The session is stored locally and the user continues in the side panel.
7. Or: **Copy package** / **Open Gemini**, for the web path.

### 4.1 Local stores (kept separate)

| Store (IndexedDB) | Contents                                                                                                                          | Mutability                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `transcripts`     | `NormalizedConversation` exactly as extracted, plus its `ExtractionReport` and the method used. One record per extraction run.    | **Append-only.** A re-extraction creates a new version; the old one is kept until the user deletes it. |
| `contextProfiles` | `ContextProfile` derived from one transcript version, with evidence message ids, the passes that produced it, and the model used. | Regenerable. Linked to a transcript version and never edits it. User edits are stored as overrides.    |
| `migrationPlans`  | The exact plan that was previewed and sent.                                                                                       | Immutable once sent: the audit trail of what left the machine.                                         |
| `sessions`        | The Gemini API conversation: plan id, model, and every turn sent and received.                                                    | Append-only per turn.                                                                                  |

Keeping these separate means a bad context pass can never corrupt the transcript. It also means any
migration can be traced back to the transcript version it came from.

### 4.2 Status the UI always shows

- **Extraction:** the method used (DOM / Export / Internal endpoint — the last marked "unofficial"), the completeness (`complete` / `partial` / `unknown`) with reasons, the message count, warnings, and the excluded items with their reasons.
- **Fallback:** if a method fails or reports `partial`, the UI names the next method to try and why. It never switches silently.
- **Migration:** plan state (`draft` → `previewed` → `sending` → `active` / `failed` / `interrupted`), and what was included, summarized and excluded.
- **Destination label:** "Gemini API chat in ChatBridge — not visible in gemini.google.com".

## 5. Normalized conversation schema (Zod in Phase 2)

```ts
NormalizedConversation {
  schemaVersion: 1
  conversationId: string          // source id
  title: string | null
  sourceProvider: 'chatgpt'       // open union in code: string literal per adapter
  createdAt?: ISO; updatedAt?: ISO
  messages: NormalizedMessage[]   // the selected path, in chronological order
  attachments: Attachment[]
  extraction: {
    method: 'dom' | 'export' | 'internal-api'
    completeness: 'complete' | 'partial' | 'unknown'
    warnings: { code, message, messageIds? }[]
    excluded: { sourceNodeId, reason }[]       // never silently dropped
  }
  metadata: Record<string, unknown>
}

NormalizedMessage {
  id: string                      // stable: source message id, else content hash
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: ContentBlock[]
  timestamp?: ISO
  visibility: 'visible' | 'hidden'          // e.g. custom-instruction nodes
  provenance: { sourceNodeId?, parentId?, siblingCount?, branchIndex? }
  contentHash: string                       // dedupe across re-extractions
  metadata: Record<string, unknown>         // model slug, finish reason, …
}

ContentBlock =
  | { type: 'text';  text: string; format: 'markdown' | 'plain' }
  | { type: 'code';  text: string; language?: string }
  | { type: 'image'; ref?: string; alt?: string; available: boolean }
  | { type: 'file';  name: string; mimeType?: string; size?: number; available: boolean }
  | { type: 'unsupported'; originalType: string; description: string }
```

Changes from the spec's draft: per-message `provenance` (needed for branches and evidence links), `contentHash` (dedupe), `visibility`, and a conversation-level `extraction` report that carries completeness and the excluded list. The spec's "never silently discard" rule is written into the data model through that report.

## 6. ChatGPT extraction strategy

### 6.0 Methods and fallback

| Method                | Role                      | Default | Completeness it can claim                                  | Shared parser                |
| --------------------- | ------------------------- | ------- | ---------------------------------------------------------- | ---------------------------- |
| **DOM**               | Normal workflow           | On      | `unknown` at best (only what renders; current branch only) | DOM → normalized             |
| **Export JSON**       | Reliable fallback         | On      | `complete` for the selected path, with all branches known  | Tree parser                  |
| **Internal endpoint** | Advanced, **unsupported** | **Off** | Same as export, but current                                | Tree parser (same as export) |

Fallback rules:

1. The user starts with DOM.
2. When DOM reports `unknown` or `partial` (e.g. branch pagers present, or the scroll test saw virtualization), the UI recommends the export and says why.
3. The internal endpoint is offered only when the user has turned it on in Settings and given consent. Any failure (`denied`, `not-found`, `rate-limited`, `unexpected-response`) is shown, and the UI falls back to DOM or export. There are no retries and no extra headers.
4. No feature requires Method 3.
5. When two methods are run on the same conversation, the transcripts are kept as separate versions. A diff summary (message counts, ids missing from either) is shown. Nothing is merged silently.

### 6.0.1 Validation before Phase 2

Validation uses **structural probes** in Diagnostics (side panel → Diagnostics). These reports contain tags, `data-*` attribute names, value _shapes_ (`<uuid>`, `<num>`, short slugs, `<str:N>`) and text **lengths**. They never contain message text, titles, file names, sidebar contents (other conversations), URLs beyond host + shaped path, or tokens. Unit tests and e2e tests plant sentinel strings everywhere and assert that none reach a report. The owner runs each probe, reviews the report, and shares it.

- Page probe: checks the selector strategies, turn and test-id patterns, a `data-*` attribute census, code-block language sources, branch pagers, images, timestamps, the scroll container, and a set of skeleton samples. An optional scroll test goes top → bottom, measures lazy loading and virtualization, and restores the scroll position.
- Endpoint probe (consent required): makes `GET /api/auth/session` and then `GET /backend-api/conversation/<id>`, with the existing session only. It reports status codes plus a tree-structure analysis. The token never leaves the function.
- Export probe: reads `conversations.json` locally and reports aggregate tree structure (content types, part kinds, branches, hidden nodes, metadata keys, problems by index).

**Selectors (from public knowledge of the current DOM; validation pending, §13):**

- Messages: `[data-message-author-role]` (values `user` / `assistant`) with `data-message-id`.
- Turns: `article[data-testid^="conversation-turn-"]`.
- Conversation id: URL `/c/<uuid>`, including project and GPT paths (`/g/<id>/c/<uuid>`).

Robustness rules: prefer `data-*` attributes over class names, which are hashed or Tailwind and change often. Keep every selector in `selectors.ts`. Each selector strategy reports which one matched, so a breaking DOM change shows up as "0 messages via strategy X" and not as silent empty output.

**DOM method (Phase 2):**

- Scroll the conversation container top → bottom and collect messages by `data-message-id` into an ordered map. This covers lazy loading and virtualization, and dedupes by id.
- Convert rendered HTML → markdown with our own walker. Code blocks become `code` blocks with the language read from the header. Never use `innerHTML` in the panel.
- Branches: the DOM shows only the _current_ branch (the "< 2/3 >" pager). Record `siblingCount` when the pager is present and mark completeness `partial` with an explanation.
- Completeness is **never** reported as `complete` from the DOM alone. Best case is `unknown`, plus the count we found.

**Export method (Phase 2):**

- Accept `conversations.json` _or_ the export `.zip` (fflate, unzipped in a Worker; exports can be hundreds of MB).
- Each conversation has `mapping: {nodeId: {message, parent, children}}` and `current_node`.
- Selected path = walk `current_node → parent → … → root`, then reverse. This is the branch the user last saw. Siblings are recorded as `siblingCount`; we do not flatten them in.
- Node handling: `text` → text; `code` (code interpreter input) → code; `execution_output` → tool; `multimodal_text` → text + image placeholders; `user_editable_context` → hidden system message _and_ preferences source; reasoning content types (`thoughts`, `reasoning_recap`) → excluded, reason "model reasoning is not transferred"; `tether_*` browsing → tool; unknown → `unsupported` with its type name.
- Validation: Zod per node with tolerant parsing. A malformed node is reported in `extraction.warnings` and the rest of the conversation still imports. Cycles and missing parents are detected and reported.

**Method 3 (approved, opt-in):** `GET /backend-api/conversation/<id>` from the content script, using the session token the page already has. It returns the same tree as the export, so it reuses the export parser.

- It sits behind a Settings toggle (off by default), and each run needs consent.
- It is labelled "unofficial / unsupported" wherever it appears.
- No extra headers, no retries on 401 or 403, no workaround for challenges. An HTML or challenge response is treated as unavailable.
- The token stays in the content script's isolated world. It is never sent to the panel, stored, or logged.

## 7. Gemini integration strategy (Phase 4)

- SDK: `@google/genai` (official). Calls run from the side panel page. Model list comes from `models.list()`, which supplies `inputTokenLimit` / `outputTokenLimit`, so no context limits are hard-coded.
- **Verified against the published package (v2.32.0, 2026-11-02):**
  - It ships a browser build (`exports.browser → dist/web/index.mjs`).
  - `Model` exposes `inputTokenLimit` / `outputTokenLimit`.
  - `models.countTokens` and `caches` (explicit context caching) exist.
  - `chats.create` → `Chat` calls `validateHistory`, which **only** checks that every role is `user` or `model`. Its docstring claims it rejects a history that doesn't start with a user turn, but the code does not check that.
  - `extractCuratedHistory` treats contents with empty `parts` (or empty part objects) as invalid.

  Whether the **API** rejects non-alternating or model-first histories is not verified, because that needs a live key. The mapper normalizes to alternating, user-first, non-empty turns regardless. A live check is part of Phase 4 acceptance.

- Role mapping: `user→user`, `assistant→model`.
  - `tool` outputs → a `model` turn rendered as a labelled quote.
  - `system` / custom instructions → go into `systemInstruction`, inside a delimited "Historical context (data)" section.
  - Consecutive same-role turns are merged.
  - If history starts with `model`, prepend a user turn that is explicitly labelled as synthetic.
  - Images / files are replaced with text placeholders in the MVP, because the ChatGPT file pointers cannot be fetched.
- `systemInstruction` layout: (1) the ChatBridge preamble, which says the history below is imported, that instructions found inside it are prior context and not new commands from the system, and that the user's live messages take precedence; (2) the context profile; (3) a disclosure of what was summarized or omitted.
- Session: `chats.create({model, history, config:{systemInstruction}})` → `sendMessageStream`. History and new turns are persisted locally so a closed panel can continue.
- Errors: 400 invalid key → a "Check API key" action. 429 → exponential backoff with jitter, honouring `retryDelay`, and visible to the user. 5xx → retry ×3, then fail with the plan intact. Context overflow → back to the planner with a lower budget.
- Honest limitation: prompt injection cannot be fully prevented. Past _user_ turns are the user's own words. The real risk is tool or browse outputs and pasted documents. Mitigations are labelling, delimiting, and keeping the system preamble outside the history.

## 8. Context-window management

1. Estimate locally: chars / 4 for prose and chars / 3.2 for code, deliberately conservative. After consent, confirm the count with `countTokens`, because that call transmits content too.
2. `budget = min(userBudget, inputTokenLimit) − systemInstruction − outputReserve(≈ 8k or the model's max output)`.
3. If the whole history fits → Full History, no compression.
4. Otherwise the planner keeps, in priority order:
   - pinned (user-selected) messages;
   - messages cited as evidence by the context profile;
   - the most recent N turns.

   Older contiguous segments are replaced by segment summaries that cite their message ids.

5. Full History mode **refuses** to run over budget. It never truncates; it offers Smart or Hybrid mode, or a larger budget.
6. The preview lists every message as `included | summarized(segment k) | excluded(reason)`. The full transcript stays in IndexedDB.

## 9. Security & privacy risks

| Risk                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini key at rest           | `chrome.storage.local` is **plaintext on disk** in the Chrome profile. It is readable by malware or anyone with profile access, and by any code running inside the extension; web pages cannot read it. "Encrypting" it with a key stored next to it is theatre, so we don't. Offer a **session-only** option (`chrome.storage.session`, memory-only, cleared on browser exit). Never log the key, and redact it in errors. |
| Conversation leakage         | Nothing leaves the machine before a consent dialog that names what is sent and to whom. No analytics or telemetry. Logs contain ids and counts, never content.                                                                                                                                                                                                                                                              |
| XSS from extracted content   | Render markdown with no raw-HTML support and sanitize all links. No `innerHTML` or `dangerouslySetInnerHTML`. Strict extension CSP (`script-src 'self'`). Extracted code is displayed and never executed.                                                                                                                                                                                                                   |
| Hostile page messaging       | The content script accepts only `chrome.runtime` messages from our own extension id (sender check) and validates every payload with Zod. No `window.postMessage` channel.                                                                                                                                                                                                                                                   |
| Malicious or huge upload     | Size cap and streaming unzip in a Worker. Zod validation, tolerant per node. Depth and cycle limits.                                                                                                                                                                                                                                                                                                                        |
| Prompt injection via history | See §7.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Over-broad permissions       | Host permissions only for ChatGPT and (later) the Gemini API. No `tabs`, no `<all_urls>`.                                                                                                                                                                                                                                                                                                                                   |
| Data retention               | A "Delete all ChatBridge data" button wipes IndexedDB and storage. Per-conversation delete.                                                                                                                                                                                                                                                                                                                                 |
| ToS                          | DOM reading is of content the user already sees. Method 3 is opt-in and labelled.                                                                                                                                                                                                                                                                                                                                           |

## 10. Testing strategy

- **Unit (Vitest + jsdom):** the URL parser, DOM detection against saved HTML fixtures, message protocol validation, tab-bridge injection fallback with a fake `chrome`. Phase 2+ adds: export tree path resolution (edits, regenerations, branches, cycles, malformed nodes), dedupe, the markdown converter, the planner (budget edges), the role mapper, and the deterministic context rules.
- **Fixtures:** hand-built but structurally faithful ChatGPT export trees (mapping, `current_node`, edited branches, `multimodal_text`, `user_editable_context`). Real exports are never committed. A script will anonymize user-provided samples.
- **LLM-dependent tests:** the Gemini client is tested against recorded HTTP responses, which test our handling of 400/429/500 and stream parsing. A separate, opt-in `test:live` suite hits the real API with a key from the environment. CI never claims a live result it didn't run.
- **Integration (Playwright):** load `dist/` into Chromium. Serve fixture pages _at_ `https://chatgpt.com/...` via request routing, so the real content script injects. Drive the side panel page.
- **Context-engine acceptance:** golden conversations with a hand-written expected profile. Assert recall of confirmed decisions _and_ zero items without resolvable evidence. No invented decisions is a hard assertion.

## 11. Phase checklist

- [x] **P0** Document reviewed · decisions C2 (side panel) and C3 (Method 3, opt-in) approved.
- [ ] **P0.5** Structural validation against a real session. Probes built and tested; owner reports **pending** (§13).
- [x] **P1** Manifest, Vite builds, side panel, content script, service worker, typed messaging, Home screen, unit + Playwright smoke test.
- [x] **P2** Zod schema · export importer (zip/json, tree, branches) · DOM extractor (scroll-collect, md conversion) · IndexedDB store · Analysis screen with extraction report.
- [x] **P3** Deterministic context pass · LLM pass with structured output + evidence validation · contradiction/supersession handling · context preview.
- [x] **P4** Key settings (local/session) · model list · mapper · Full History + Smart modes · side-panel chat continuation · error handling.
- [x] **P5** Planner + budgets + segment summaries · checkpoints/resume · data deletion · hardening review · broader integration tests.
- [x] **P6** Hybrid mode (if P4/P5 are solid) · UI polish · README, setup guides, troubleshooting, screenshots.

## 12. Technical risks

| Risk                                                         | Likelihood | Impact                 | Mitigation                                                                                  |
| ------------------------------------------------------------ | ---------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| ChatGPT DOM changes                                          | High       | DOM extraction breaks  | Isolated selectors, strategy reporting, fixture tests, export path as the reliable fallback |
| Users expect the chat to appear in gemini.google.com         | High       | Perceived failure      | Explicit wording in the UI (C1), plus a copy-package flow for the web                       |
| Huge exports (>500 MB)                                       | Medium     | Panel OOM              | Worker + streaming unzip; parse only the selected conversation                              |
| LLM context pass hallucinates                                | Medium     | Wrong "decisions"      | Evidence ids required and validated; assistant-only evidence downgraded to "proposed"       |
| Per-turn cost of long histories                              | Medium     | Expensive continuation | Practical budget default, cost estimate in preview, context caching (P5)                    |
| Gemini model ids / limits change                             | High       | Broken defaults        | Discover via `models.list()`                                                                |
| MV3 worker termination                                       | Certain    | Lost job state         | Long work in side panel + IndexedDB checkpoints                                             |
| Internal ChatGPT endpoint (if adopted) changes or is blocked | Medium     | Method 3 breaks        | Optional and isolated; fall back to the other two methods                                   |

## 13. Validation status

| Assumption                                                           | Status                                    | Evidence                                                           |
| -------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| Messages carry `data-message-author-role` and `data-message-id`      | **Pending** owner page probe              | Fixture only                                                       |
| Turns are `article[data-testid^="conversation-turn-"]`               | **Pending** owner page probe              | Fixture only                                                       |
| Long conversations are fully rendered vs lazy-loaded or virtualized  | **Pending** owner scroll test             | Scroll test logic verified on a 40-turn synthetic page in Chromium |
| Code-block language is exposed as a class or header label            | **Pending** owner page probe              | —                                                                  |
| Branch pager is a leaf with `n/m` text between previous/next buttons | **Pending** owner page probe              | —                                                                  |
| Export uses `mapping` / `current_node` with the content types in §6  | **Pending** owner export probe            | Synthetic fixture built from public knowledge of the format        |
| Internal endpoint returns the same tree with only the session token  | **Pending** owner endpoint probe (opt-in) | —                                                                  |
| Gemini SDK history validation and model limits                       | **Verified** (package source)             | §7                                                                 |
| Gemini API acceptance of non-alternating history                     | Not verified (needs a key)                | Mapper normalizes regardless                                       |
| Probes leak no content, titles, sidebar items or tokens              | **Verified** (tests)                      | Sentinel assertions in unit + e2e suites                           |

## 14. Implementation notes (rev 3)

Decisions and findings made while building Phases 2–6:

- **Transcript persistence goes through the service worker.** Content scripts cannot open the
  extension's IndexedDB, so the content script sends the validated transcript to the worker, which
  stores it. Closing the panel mid-extraction therefore does not lose the result.
- **Sessions are rebuilt from storage on every turn.** The Gemini API is stateless, so each message is
  sent with the imported history plus completed turns. The user turn and a `pending` model turn are
  written _before_ the request. A `pending` turn found on load is marked interrupted and offered for retry.
- **SDK finding (verified by an e2e test, fixed):** `Chat.sendMessageStream({ config })` **replaces**
  the chat-level config, it does not merge. Passing only an abort signal silently dropped the system
  instruction. The client now sends the full config with every message, and a regression test covers it.
- **Chromium finding (fixed):** newer Chromium returns a Promise from `scrollIntoView()`, which React
  treated as an effect cleanup and crashed on. Effects now use block bodies.
- **Context evidence is enforced, not requested.** Gemini items must reference existing message ids,
  with quotes found verbatim (after whitespace and markdown normalization) in those messages.
  Otherwise they are dropped and counted. A "confirmed" item that only assistant messages support is
  downgraded to "proposed".
- **Supersession is deterministic.** An earlier "use X" is marked superseded by a later "don't use X"
  (and vice versa). Both are kept. Conflicts inside one message are marked contradicted, not resolved.
- **Gemini history normalization:**
  - assistant → `model`; tool output → a labelled `model` turn; visible system messages → the system
    instruction.
  - Same-role runs are merged; a synthetic labelled user turn is prepended if history starts with
    `model`, and a labelled model turn is appended if it ends with `user`.
  - Every adjustment is counted in the session's `mapReport`.
- **Token budget:** local estimates are conservative (3.6 chars/token for prose, 3.0 for code). The
  budget defaults to 200k tokens, user-adjustable and capped at the model's `inputTokenLimit` from
  `models.list()`.
