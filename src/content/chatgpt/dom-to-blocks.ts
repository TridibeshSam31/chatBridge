import type { ContentBlock } from '../../core/conversation/schema';
import { CODE_BLOCK, CODE_SOURCE, COPY_EXCLUDED, LANGUAGE_LABEL } from './selectors';

/**
 * Converts rendered ChatGPT message HTML into content blocks: markdown text plus
 * separate code blocks. Reads text only (textContent) and never copies HTML, so
 * nothing from the page can execute in ChatBridge.
 */

const SKIP = new Set(['BUTTON', 'SVG', 'svg', 'STYLE', 'SCRIPT', 'TEMPLATE']);
const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'HR',
  'IMG',
  'DIV',
  'SECTION',
]);

export function elementToBlocks(root: Element): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let text = '';

  const flush = () => {
    const t = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (t) blocks.push({ type: 'text', text: t, format: 'markdown' });
    text = '';
  };

  const block = (el: Element, indent = '') => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent ?? '';
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const c = child as Element;
      if (SKIP.has(c.tagName)) continue;
      if (c.matches(CODE_BLOCK)) {
        flush();
        blocks.push(codeBlock(c));
        continue;
      }
      if (c.matches(COPY_EXCLUDED)) continue;

      switch (c.tagName) {
        case 'P':
          text += inline(c) + '\n\n';
          break;
        case 'H1':
        case 'H2':
        case 'H3':
        case 'H4':
        case 'H5':
        case 'H6':
          text += '#'.repeat(Number(c.tagName[1])) + ' ' + inline(c).trim() + '\n\n';
          break;
        case 'UL':
        case 'OL':
          text += list(c, indent) + '\n';
          break;
        case 'PRE':
          flush();
          blocks.push(codeBlock(c));
          break;
        case 'BLOCKQUOTE':
          text +=
            inline(c)
              .trim()
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n') + '\n\n';
          break;
        case 'TABLE':
          text += table(c) + '\n\n';
          break;
        case 'HR':
          text += '---\n\n';
          break;
        case 'IMG':
          flush();
          blocks.push(imageBlock(c));
          break;
        default:
          if (hasBlockChild(c)) block(c, indent);
          else text += inline(c);
      }
    }
  };

  block(root);
  flush();
  return blocks;
}

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName) || hasBlockChild(c));
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if (SKIP.has(el.tagName) || el.matches(COPY_EXCLUDED)) return '';
  if (el.classList.contains('katex')) {
    const tex = el.querySelector('annotation')?.textContent;
    return tex ? `$${tex}$` : (el.textContent ?? '');
  }
  const inner = () => Array.from(el.childNodes).map(inline).join('');
  switch (el.tagName) {
    case 'BR':
      return '\n';
    case 'CODE':
      return '`' + (el.textContent ?? '') + '`';
    case 'STRONG':
    case 'B':
      return `**${inner()}**`;
    case 'EM':
    case 'I':
      return `*${inner()}*`;
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      const label = inner();
      return /^https?:\/\//i.test(href) && href !== label ? `[${label}](${href})` : label;
    }
    case 'IMG':
      return el.getAttribute('alt') ? `[image: ${el.getAttribute('alt')}]` : '[image]';
    case 'P':
    case 'DIV':
      return inner() + '\n';
    case 'UL':
    case 'OL':
      return list(el, '');
    default:
      return inner();
  }
}

function list(el: Element, indent: string): string {
  const ordered = el.tagName === 'OL';
  const start = Number(el.getAttribute('start') ?? '1') || 1;
  let out = '';
  Array.from(el.children)
    .filter((c) => c.tagName === 'LI')
    .forEach((li, i) => {
      const marker = ordered ? `${start + i}. ` : '- ';
      const own = Array.from(li.childNodes)
        .filter((n) => !(n instanceof Element && (n.tagName === 'UL' || n.tagName === 'OL')))
        .map(inline)
        .join('')
        .trim()
        .replace(/\n+/g, ' ');
      out += `${indent}${marker}${own}\n`;
      for (const nested of Array.from(li.children).filter(
        (c) => c.tagName === 'UL' || c.tagName === 'OL',
      )) {
        out += list(nested, indent + '  ');
      }
    });
  return out;
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children).map((cell) =>
      inline(cell).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '),
    ),
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) =>
    '| ' + Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [
    line(rows[0]!),
    '| ' + Array(width).fill('---').join(' | ') + ' |',
    ...rows.slice(1).map(line),
  ].join('\n');
}

/**
 * A code block: a <pre> (older layout) or a [data-code-block] container whose
 * header holds the language label and whose source sits in [data-code-block-source].
 */
function codeBlock(container: Element): ContentBlock {
  const source = container.querySelector(CODE_SOURCE) ?? container.querySelector('code');
  let language: string | undefined;
  for (const token of Array.from(source?.classList ?? [])) {
    const m = /^(?:language|lang)-(.+)$/.exec(token);
    if (m) language = m[1];
  }
  if (!language) {
    // Header label: a short text node outside the source and outside buttons.
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (source?.contains(n) || n.parentElement?.closest('button')) continue;
      const t = n.textContent?.trim() ?? '';
      if (t && LANGUAGE_LABEL.test(t)) {
        if (!/^plain ?text$/i.test(t)) language = t.toLowerCase();
        break;
      }
    }
  }
  const text = source ? renderedText(source) : textWithoutChrome(container);
  return { type: 'code', text: text.replace(/\n$/, ''), ...(language ? { language } : {}) };
}

/**
 * Text as displayed. Editor-style code views put each line in its own element,
 * so textContent would run the lines together; innerText keeps the line breaks.
 */
function renderedText(el: Element): string {
  const shown = (el as HTMLElement).innerText as string | undefined;
  if (typeof shown === 'string' && shown !== '') return shown;
  // No layout (e.g. jsdom): treat child elements as lines when the text has none.
  const text = el.textContent ?? '';
  return el.children.length > 1 && !text.includes('\n')
    ? Array.from(el.children, (line) => line.textContent ?? '').join('\n')
    : text;
}

/** Text of an element without buttons and other page chrome inside it. */
export function textWithoutChrome(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const junk of Array.from(copy.querySelectorAll(`button, svg, ${COPY_EXCLUDED}`)))
    junk.remove();
  return copy.textContent ?? '';
}

function imageBlock(img: Element): ContentBlock {
  const alt = img.getAttribute('alt');
  return { type: 'image', available: false, ...(alt ? { alt } : {}) };
}
