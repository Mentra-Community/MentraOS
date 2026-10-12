const SECRET = /authorization|cookie|password|secret|token|api[_-]?key/i;
export function scrubString(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:xox[baprs]-|msk_)[A-Za-z0-9-]+/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b((?:access|refresh|core|api)[_-]?(?:token|key)|password|secret)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]');
}
export function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') {
    const text = scrubString(value);
    return text.length > 4096 ? text.slice(0, 4096) + '[TRUNCATED]' : text;
  }
  if (typeof value === 'bigint') return String(value);
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? '[FUNCTION]' : value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (value instanceof Error) return sanitize({name: value.name, message: value.message, stack: value.stack, cause: value.cause}, depth + 1, seen);
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      const items = value.slice(0, 100).map(item => sanitize(item, depth + 1, seen));
      if (value.length > 100) items.push('[TRUNCATED]');
      return items;
    }
    const keys = Object.keys(value), output: Record<string, unknown> = {};
    for (const key of keys.slice(0, 100)) {
      try { output[key] = SECRET.test(key) ? '[REDACTED]' : sanitize((value as Record<string, unknown>)[key], depth + 1, seen); }
      catch { output[key] = '[UNREADABLE]'; }
    }
    if (keys.length > 100) output.truncated = true;
    return output;
  } finally { seen.delete(value); }
}
