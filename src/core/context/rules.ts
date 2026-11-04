import type { NormalizedConversation, NormalizedMessage } from '../conversation/schema';
import { hashString } from '../../shared/hash';
import {
  type Category,
  type ContextItem,
  type ContextProfile,
  type Evidence,
  type ItemStatus,
  emptyItems,
  emptyStats,
} from './schema';

/**
 * Deterministic context pass. Runs locally, needs no network, and only reports
 * what is literally present in the transcript. Assistant suggestions are never
 * treated as decisions unless the user's next message explicitly accepts them.
 */

const STYLE =
  /\b(be (?:concise|brief|short|detailed|thorough|direct)|keep (?:it|answers|responses) (?:short|brief|simple)|(?:short|brief|concise|detailed) (?:answers|responses|explanations)|step[- ]by[- ]step|no (?:emojis?|fluff|filler|small talk)|explain (?:it )?(?:simply|like)|in (?:hindi|english|hinglish|spanish|french|german)|use bullet points|plain language|formal tone|casual tone)\b/i;
const INSTRUCTION =
  /\b(always|never|from now on|going forward|make sure (?:to|you)|don't|do not|i want you to|you (?:must|should)|please (?:use|avoid|keep|write|don't|do not|stop)|stop (?:using|doing))\b/i;
/** Imperative corrections such as "Use Zustand instead." */
const IMPERATIVE = /^(?:actually,?\s*)?(?:use|avoid|prefer|switch to)\s+\S+/i;
const CONSTRAINT =
  /\b(must not|must|can't|cannot|has to|have to|needs? to be|only (?:use|allowed|works)|not allowed|no (?:backend|server|database|external|budget|internet)|without (?:a |any )?(?:backend|server|database|library|libraries|dependencies)|deadline|limited to|compatible with)\b/i;
const DECISION =
  /\b(let'?s (?:go with|use|do)|we(?:'ll| will| are going to) (?:use|go with)|i(?:'ll| will|'m going to) (?:use|go with)|(?:we|i) decided|decided to|going with|switch(?:ing)? to|settled on)\b/i;
const PREFERENCE =
  /\b(i (?:prefer|like|love|hate|don'?t like|dislike|would rather|'d rather)|my preference)\b/i;
const PENDING =
  /\b(todo|to-do|still need(?:s)? to|next (?:we|i) (?:need|want|have) to|later (?:we|i)|we need to add|add support for|haven'?t (?:done|implemented|added)|not (?:yet )?implemented)\b/i;
const IMPLEMENTED =
  /\b(i(?:'ve| have) (?:implemented|added|built|finished|completed|deployed)|(?:is|are) (?:done|implemented|finished|working now)|now works)\b/i;
const SUGGESTION =
  /\b(i (?:recommend|suggest|would suggest|'d suggest|'d recommend)|you should|the best (?:option|approach|choice) is|consider using|i propose)\b/i;
const ACCEPT =
  /^\s*(ok(?:ay)?|sure|yes|yep|yeah|sounds good|let'?s do (?:it|that)|go ahead|perfect|great|agreed|do it|that works|lets go|haan|theek hai)\b/i;
const PROBLEM =
  /\b(error|exception|traceback|stack trace|fails?|failing|failed|bug|doesn'?t work|does not work|not working|isn'?t working|broken|crash(?:es|ed|ing)?|undefined is not|cannot read|returns? (?:a )?[45]\d\d)\b/i;
const RESOLVED =
  /\b(fixed|works now|that worked|it works|it worked|solved|resolved|working now|that did it|that fixed it)\b/i;
const ERROR_LINE = /^\s*((?:[A-Z]\w*)?(?:Error|Exception)\b[^\n]{0,160})/m;
const FILE_PATH =
  /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|json|ya?ml|toml|md|css|scss|html|sql|sh|env|prisma|graphql|vue|svelte))(?=$|[\s`'"),:;.])/gm;
const POSITIVE_TARGET =
  /\b(?:use|using|go with|switch(?:ing)? to|prefer|choose)\s+([A-Za-z][\w.+#-]*)/gi;
const NEGATIVE_TARGET =
  /\b(?:don'?t|do not|never|stop|avoid|no longer|instead of)\s+(?:use\s+|using\s+)?([A-Za-z][\w.+#-]*)/gi;
const STOP_TARGETS = new Set([
  'the',
  'a',
  'an',
  'it',
  'this',
  'that',
  'them',
  'any',
  'some',
  'my',
  'your',
  'to',
  'be',
  'do',
  'use',
  'using',
]);

/** Technologies recognised by name. Matching is case-insensitive on word boundaries. */
const TECH: [string, RegExp][] = [
  ['TypeScript', /\btypescript\b|\bts\b(?=\s+(?:code|types?|file))/i],
  ['JavaScript', /\bjavascript\b/i],
  ['Python', /\bpython\b/i],
  ['Go', /\bgolang\b/i],
  ['Rust', /\brust\b/i],
  ['Java', /\bjava\b(?!script)/i],
  ['Kotlin', /\bkotlin\b/i],
  ['Swift', /\bswift\b/i],
  ['C#', /\bc#|\.net\b/i],
  ['C++', /\bc\+\+/i],
  ['PHP', /\bphp\b/i],
  ['Ruby', /\bruby\b/i],
  ['SQL', /\bsql\b/i],
  ['React', /\breact\b/i],
  ['Next.js', /\bnext\.?js\b/i],
  ['Vue', /\bvue(?:\.js)?\b/i],
  ['Svelte', /\bsvelte\b/i],
  ['Angular', /\bangular\b/i],
  ['Vite', /\bvite\b/i],
  ['Tailwind CSS', /\btailwind\b/i],
  ['Node.js', /\bnode(?:\.js|js)?\b/i],
  ['Express', /\bexpress(?:\.js)?\b/i],
  ['NestJS', /\bnest(?:js)?\b/i],
  ['Django', /\bdjango\b/i],
  ['Flask', /\bflask\b/i],
  ['FastAPI', /\bfastapi\b/i],
  ['Spring', /\bspring boot\b/i],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
  ['MySQL', /\bmysql\b/i],
  ['SQLite', /\bsqlite\b/i],
  ['MongoDB', /\bmongo(?:db)?\b/i],
  ['Redis', /\bredis\b/i],
  ['Prisma', /\bprisma\b/i],
  ['GraphQL', /\bgraphql\b/i],
  ['Docker', /\bdocker\b/i],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['AWS', /\baws\b/i],
  ['GCP', /\bgcp\b|google cloud/i],
  ['Azure', /\bazure\b/i],
  ['Firebase', /\bfirebase\b/i],
  ['Supabase', /\bsupabase\b/i],
  ['Vercel', /\bvercel\b/i],
  ['Git', /\bgit\b(?!hub)/i],
  ['GitHub Actions', /\bgithub actions\b/i],
  ['Zod', /\bzod\b/i],
  ['Vitest', /\bvitest\b/i],
  ['Jest', /\bjest\b/i],
  ['Playwright', /\bplaywright\b/i],
  ['Chrome Extension (MV3)', /\bmanifest v3\b|\bmv3\b|chrome extension/i],
  ['Gemini API', /\bgemini api\b/i],
  ['OpenAI API', /\bopenai api\b/i],
  ['LangChain', /\blangchain\b/i],
  ['TensorFlow', /\btensorflow\b/i],
  ['PyTorch', /\bpytorch\b|\btorch\b/i],
  ['Flutter', /\bflutter\b/i],
  ['React Native', /\breact native\b/i],
  ['Electron', /\belectron\b/i],
] as [string, RegExp][];
const LANGUAGE_TECH: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JavaScript',
  py: 'Python',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  rs: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  csharp: 'C#',
  cs: 'C#',
  cpp: 'C++',
  php: 'PHP',
  ruby: 'Ruby',
  sql: 'SQL',
  dockerfile: 'Docker',
};

interface Sentence {
  text: string;
  message: NormalizedMessage;
  index: number;
}

export function runRules(
  conversation: NormalizedConversation,
  transcriptId: string,
): ContextProfile {
  const items = emptyItems();
  const visible = conversation.messages.filter(
    (m) => m.visibility === 'visible' && (m.role === 'user' || m.role === 'assistant'),
  );
  const indexOf = new Map(conversation.messages.map((m, i) => [m.id, i]));
  const add = (
    category: Category,
    text: string,
    status: ItemStatus,
    evidence: Evidence[],
    extra: Partial<ContextItem> = {},
  ) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const order = Math.max(0, ...evidence.map((e) => indexOf.get(e.messageId) ?? 0));
    const existing = items[category].find((i) => normalize(i.text) === normalize(clean));
    if (existing) {
      for (const e of evidence)
        if (!existing.evidence.some((x) => x.messageId === e.messageId)) existing.evidence.push(e);
      existing.order = Math.max(existing.order, order);
      return;
    }
    items[category].push({
      id: `${category}-${hashString(clean + (evidence[0]?.messageId ?? ''))}`,
      text: clean,
      status,
      source: 'rules',
      evidence,
      order,
      ...extra,
    });
  };

  // Standing instructions from the source (e.g. ChatGPT custom instructions).
  for (const ctx of conversation.userContext) {
    const evidence = ctx.sourceMessageId
      ? [{ messageId: ctx.sourceMessageId, quote: excerpt(ctx.text, 200) }]
      : [];
    add('userPreferences', `${ctx.label}: ${excerpt(ctx.text, 600)}`, 'confirmed', evidence, {
      source: 'custom-instructions',
    });
  }

  const users = visible.filter((m) => m.role === 'user');

  for (const message of users) {
    for (const s of sentences(message)) {
      const ev = [{ messageId: message.id, quote: excerpt(s.text, 200) }];
      if (STYLE.test(s.text)) add('communicationStyle', s.text, 'confirmed', ev);
      else if (INSTRUCTION.test(s.text) || IMPERATIVE.test(s.text))
        add('explicitInstructions', s.text, 'confirmed', ev);
      else if (CONSTRAINT.test(s.text)) add('constraints', s.text, 'confirmed', ev);
      else if (DECISION.test(s.text)) add('decisions', s.text, 'confirmed', ev);
      else if (PREFERENCE.test(s.text)) add('userPreferences', s.text, 'confirmed', ev);
      if (PENDING.test(s.text)) add('pendingFeatures', s.text, 'confirmed', ev);
      if (IMPLEMENTED.test(s.text)) add('implementedFeatures', s.text, 'confirmed', ev);
    }
  }

  // Assistant proposals become decisions only when the next user message accepts them.
  visible.forEach((message, i) => {
    if (message.role !== 'assistant') return;
    const suggestions = sentences(message).filter((s) => SUGGESTION.test(s.text));
    if (suggestions.length === 0) return;
    const reply = visible.slice(i + 1).find((m) => m.role === 'user');
    const replyText = reply ? textOf(reply) : '';
    const accepted = reply !== undefined && ACCEPT.test(replyText);
    for (const s of suggestions) {
      const ev: Evidence[] = [{ messageId: message.id, quote: excerpt(s.text, 200) }];
      if (accepted) ev.push({ messageId: reply.id, quote: excerpt(replyText, 120) });
      add('decisions', s.text, accepted ? 'confirmed' : 'proposed', ev);
    }
  });

  technology(visible, add);
  problems(visible, add);
  files(visible, add);

  const lastUser = users.at(-1);
  if (lastUser)
    add('currentTask', `Latest user request: ${excerpt(textOf(lastUser), 400)}`, 'confirmed', [
      { messageId: lastUser.id, quote: excerpt(textOf(lastUser), 200) },
    ]);
  const firstUser = users[0];
  if (firstUser)
    add('objective', `Conversation started with: ${excerpt(textOf(firstUser), 300)}`, 'inferred', [
      { messageId: firstUser.id, quote: excerpt(textOf(firstUser), 200) },
    ]);
  const last = visible.at(-1);
  if (last?.role === 'user') {
    add(
      'nextAction',
      'Respond to the latest user request (it has no reply in the original conversation).',
      'inferred',
      [{ messageId: last.id }],
    );
  } else if (last?.role === 'assistant') {
    const question = sentences(last)
      .filter((s) => s.text.endsWith('?'))
      .at(-1);
    if (question)
      add(
        'nextAction',
        `Continue from the assistant's last question: ${question.text}`,
        'inferred',
        [{ messageId: last.id, quote: excerpt(question.text, 200) }],
      );
  }

  applySupersession(items);

  return {
    schemaVersion: 1,
    transcriptId,
    generatedAt: new Date().toISOString(),
    passes: ['rules'],
    conversationSummary: '',
    items,
    stats: { ...emptyStats(), messagesAnalyzed: visible.length },
  };
}

type Add = (
  category: Category,
  text: string,
  status: ItemStatus,
  evidence: Evidence[],
  extra?: Partial<ContextItem>,
) => void;

function technology(messages: NormalizedMessage[], add: Add) {
  const found = new Map<string, { user: Evidence[]; assistant: Evidence[] }>();
  const note = (name: string, message: NormalizedMessage, quote?: string) => {
    const entry = found.get(name) ?? { user: [], assistant: [] };
    const list = message.role === 'user' ? entry.user : entry.assistant;
    if (list.length < 3 && !list.some((e) => e.messageId === message.id))
      list.push({ messageId: message.id, ...(quote ? { quote } : {}) });
    found.set(name, entry);
  };
  for (const message of messages) {
    for (const s of sentences(message)) {
      for (const [name, pattern] of TECH)
        if (pattern.test(s.text)) note(name, message, excerpt(s.text, 200));
    }
    for (const block of message.content) {
      if (block.type !== 'code' || !block.language) continue;
      const name = LANGUAGE_TECH[block.language.toLowerCase()];
      if (name) note(name, message);
    }
  }
  for (const [name, { user, assistant }] of found) {
    if (user.length > 0) add('technologyStack', name, 'confirmed', [...user, ...assistant]);
    else add('technologyStack', name, 'proposed', assistant);
  }
}

function problems(messages: NormalizedMessage[], add: Add) {
  const userIdx = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  userIdx.forEach((i, k) => {
    const message = messages[i]!;
    const text = textOf(message);
    const errorLine = message.content
      .map((b) => (b.type === 'code' ? ERROR_LINE.exec(b.text)?.[1] : undefined))
      .find(Boolean);
    const sentence = sentences(message).find((s) => PROBLEM.test(s.text));
    if (!sentence && !errorLine) return;

    // Resolved if a later user message, before the next problem report, says so.
    let resolvedBy: NormalizedMessage | undefined;
    for (const j of userIdx.slice(k + 1)) {
      const later = messages[j]!;
      const laterText = textOf(later);
      if (RESOLVED.test(laterText)) {
        resolvedBy = later;
        break;
      }
      if (PROBLEM.test(laterText)) break;
    }
    const description = [sentence?.text, errorLine].filter(Boolean).join(' — ');
    const ev: Evidence[] = [
      { messageId: message.id, quote: excerpt(sentence?.text ?? errorLine ?? text, 200) },
    ];
    if (resolvedBy) ev.push({ messageId: resolvedBy.id, quote: excerpt(textOf(resolvedBy), 120) });
    add('knownBugs', description, 'inferred', ev, { resolved: resolvedBy !== undefined });
    if (!resolvedBy) add('unresolvedIssues', description, 'inferred', ev.slice(0, 1));

    const reply = messages.slice(i + 1).find((m) => m.role === 'assistant');
    const suggestion = reply ? sentences(reply)[0] : undefined;
    if (reply && suggestion) {
      const worked =
        resolvedBy !== undefined && messages.indexOf(resolvedBy) > messages.indexOf(reply);
      add(
        'attemptedSolutions',
        `${suggestion.text}${worked ? ' (the user later reported it worked)' : ''}`,
        worked ? 'confirmed' : 'proposed',
        [
          { messageId: reply.id, quote: excerpt(suggestion.text, 200) },
          ...(worked ? [{ messageId: resolvedBy!.id }] : []),
        ],
      );
    }
  });
}

function files(messages: NormalizedMessage[], add: Add) {
  const seen = new Map<string, { status: ItemStatus; evidence: Evidence[] }>();
  for (const message of messages) {
    const text = message.content
      .map((b) => (b.type === 'text' || b.type === 'code' ? b.text : ''))
      .join('\n');
    for (const match of text.matchAll(FILE_PATH)) {
      const path = match[1]!;
      if (/^\d/.test(path) || path.length > 120) continue;
      const entry = seen.get(path) ?? { status: 'proposed' as ItemStatus, evidence: [] };
      if (message.role === 'user') entry.status = 'confirmed';
      if (entry.evidence.length < 3 && !entry.evidence.some((e) => e.messageId === message.id))
        entry.evidence.push({ messageId: message.id, quote: path });
      seen.set(path, entry);
    }
  }
  for (const [path, { status, evidence }] of [...seen].slice(0, 40)) {
    add('importantHistoricalFacts', `File referenced: ${path}`, status, evidence);
  }
}

/**
 * Later explicit statements win: an earlier "use X" is superseded by a later
 * "don't use X" (and vice versa). Both items are kept. Conflicts within the
 * same message cannot be ordered, so both are marked contradicted.
 */
export function applySupersession(items: Record<Category, ContextItem[]>) {
  const pool = (
    [
      'explicitInstructions',
      'decisions',
      'constraints',
      'userPreferences',
      'communicationStyle',
    ] as const
  )
    .flatMap((c) => items[c])
    .filter((i) => i.status !== 'superseded' && i.status !== 'proposed');
  const targets = pool.map((item) => ({
    item,
    pos: extractTargets(item.text, POSITIVE_TARGET),
    neg: extractTargets(item.text, NEGATIVE_TARGET),
  }));
  for (const a of targets) {
    for (const b of targets) {
      if (a === b) continue;
      const conflict = [...a.pos].some((t) => b.neg.has(t)) || [...a.neg].some((t) => b.pos.has(t));
      if (!conflict) continue;
      if (a.item.order < b.item.order) {
        a.item.status = 'superseded';
        a.item.supersededBy = b.item.id;
      } else if (a.item.order === b.item.order && a.item.status !== 'superseded') {
        a.item.status = 'contradicted';
        a.item.conflictsWith = [...new Set([...(a.item.conflictsWith ?? []), b.item.id])];
      }
    }
  }
}

function extractTargets(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(pattern)) {
    const t = m[1]!.toLowerCase().replace(/[.,;:]+$/, '');
    if (!STOP_TARGETS.has(t)) out.add(t);
  }
  return out;
}

function textOf(message: NormalizedMessage): string {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n');
}

function sentences(message: NormalizedMessage): Sentence[] {
  return textOf(message)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((t) => t.replace(/^[-*#>\d.)\s]+/, '').trim())
    .filter((t) => t.length >= 3)
    .map((text, index) => ({ text, message, index }));
}

export function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
