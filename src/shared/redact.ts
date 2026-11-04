/**
 * Helpers for diagnostics that must describe *structure* without revealing
 * content. Reports built with these are shown to the user to review and share,
 * so anything that could be conversation text, a title, a file name or a
 * credential is reduced to its shape (e.g. "<str:42>").
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^-?\d+(\.\d+)?$/;
// Short identifier-like tokens: role names, test ids, content types, model slugs.
const SLUG = /^[a-z][a-z0-9_.:-]{0,47}$/i;

export function shapeOf(value: string): string {
  if (UUID.test(value)) return '<uuid>';
  if (NUMBER.test(value)) return '<num>';
  if (SLUG.test(value)) return value.replace(/\d+/g, '#');
  return `<str:${value.length}>`;
}

/** Host plus shaped path segments; query strings and fragments are dropped. */
export function urlShape(value: string, base = 'https://chatgpt.com'): string {
  try {
    const url = new URL(value, base);
    const path = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => shapeOf(decodeURIComponent(segment)))
      .join('/');
    return `${url.protocol}//${url.host}/${path}`;
  } catch {
    // Unparseable URLs are described only by length, like any other string.
    return `<str:${value.length}>`;
  }
}

/** Keys whose string values are schema enums rather than content. */
const ENUM_KEYS = new Set([
  'content_type',
  'role',
  'recipient',
  'status',
  'language',
  'mime_type',
  'type',
]);

/**
 * Replaces every value in a JSON tree with its shape. Object keys are kept (they
 * are schema), strings become lengths unless their key is an enum, numbers
 * become "<num>", arrays keep their first three items.
 */
export function redactShape(value: unknown, depth = 0, key?: string): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return key !== undefined && ENUM_KEYS.has(key) ? shapeOf(value) : `<str:${value.length}>`;
  }
  if (typeof value === 'number') return '<num>';
  if (depth >= 6) return '<…>';
  if (Array.isArray(value)) {
    const head = value.slice(0, 3).map((item) => redactShape(item, depth + 1));
    return value.length > 3 ? [...head, `<+${value.length - 3} more>`] : head;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactShape(v, depth + 1, k);
    return out;
  }
  return `<${typeof value}>`;
}

export type Histogram = Record<string, number>;

export function bump(histogram: Histogram, key: string, by = 1): void {
  histogram[key] = (histogram[key] ?? 0) + by;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
