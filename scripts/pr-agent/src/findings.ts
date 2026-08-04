import { createHash } from 'node:crypto';
import {
  VerdictSchema,
  type Finding,
  type PrAgentState,
  type ReviewSlot,
  type Verdict,
} from './types.js';

export function fingerprintFinding(file: string, message: string): string {
  const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
  const normalizedMessage = message
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  const messageHash = createHash('sha1')
    .update(normalizedMessage)
    .digest('hex')
    .slice(0, 12);
  return `${normalizedFile}:${messageHash}`;
}

export function shortId(fingerprint: string): string {
  return createHash('sha1').update(fingerprint).digest('hex').slice(0, 6);
}

export function verdictToFindings(
  verdict: Verdict,
  source: ReviewSlot | string,
  cycle: number,
): { blocking: Finding[]; nits: Finding[] } {
  const blocking: Finding[] = [];
  const nits: Finding[] = [];

  for (const f of verdict.findings) {
    const fp = fingerprintFinding(f.file || 'unknown', f.message);
    const item: Finding = {
      id: shortId(fp),
      fingerprint: fp,
      source,
      severity: f.severity,
      file: f.file,
      line: f.line,
      message: f.message,
      status: 'open',
      introducedCycle: cycle,
      lastSeenCycle: cycle,
    };
    if (f.severity === 'blocking') blocking.push(item);
    else nits.push(item);
  }
  return { blocking, nits };
}

export function mergeFindings(
  existing: Finding[],
  incoming: Finding[],
  cycle: number,
): { merged: Finding[]; newFingerprints: string[] } {
  const byFp = new Map(existing.map((f) => [f.fingerprint, f]));
  const newFingerprints: string[] = [];

  for (const f of incoming) {
    const prev = byFp.get(f.fingerprint);
    if (prev) {
      byFp.set(f.fingerprint, {
        ...prev,
        lastSeenCycle: cycle,
        message: f.message,
        line: f.line ?? prev.line,
      });
    } else {
      byFp.set(f.fingerprint, {
        ...f,
        introducedCycle: cycle,
        lastSeenCycle: cycle,
      });
      newFingerprints.push(f.fingerprint);
    }
  }

  return { merged: [...byFp.values()], newFingerprints };
}

export function resolveOpenFindingsFromSource(
  openFindings: Finding[],
  resolvedFindings: Finding[],
  source: string,
  cycle: number,
): { open: Finding[]; resolved: Finding[] } {
  const toResolve = openFindings.filter(
    (f) => f.source === source && f.severity === 'blocking' && f.status === 'open',
  );
  if (toResolve.length === 0) {
    return { open: openFindings, resolved: resolvedFindings };
  }
  const resolvedIds = new Set(toResolve.map((f) => f.fingerprint));
  const open = openFindings.filter((f) => !resolvedIds.has(f.fingerprint));
  const resolved = [
    ...resolvedFindings,
    ...toResolve.map((f) => ({ ...f, status: 'resolved' as const, lastSeenCycle: cycle })),
  ];
  return { open, resolved };
}

/**
 * Per-fingerprint resolution: `source` produced a genuine review this cycle
 * (`currentFingerprints` is its complete current blocking list). Any
 * previously-open finding attributed to `source` that is NOT in that list is
 * treated as fixed — the reviewer re-examined the PR and silently dropped it.
 *
 * This must run independently of the overall verdict. Gating resolution on a
 * fully clean "approve" (as `resolveOpenFindingsFromSource` alone did) means a
 * single new or repeated blocking item keeps every older, already-fixed
 * finding from the same source open forever, since the ledger never removes
 * a finding just because it stopped being reported.
 */
export function resolveStaleFindingsFromSource(
  openFindings: Finding[],
  resolvedFindings: Finding[],
  source: string,
  currentFingerprints: Set<string>,
  cycle: number,
): { open: Finding[]; resolved: Finding[] } {
  const toResolve = openFindings.filter(
    (f) =>
      f.source === source &&
      f.severity === 'blocking' &&
      f.status === 'open' &&
      !currentFingerprints.has(f.fingerprint),
  );
  if (toResolve.length === 0) {
    return { open: openFindings, resolved: resolvedFindings };
  }
  const resolvedIds = new Set(toResolve.map((f) => f.fingerprint));
  const open = openFindings.filter((f) => !resolvedIds.has(f.fingerprint));
  const resolved = [
    ...resolvedFindings,
    ...toResolve.map((f) => ({ ...f, status: 'resolved' as const, lastSeenCycle: cycle })),
  ];
  return { open, resolved };
}

export function openBlocking(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'blocking' && f.status === 'open');
}

/** Extract finding ids from `agent-resolve <id>` human comments. */
export function parseResolveIds(commentBodies: Array<string | null | undefined>): string[] {
  const ids = new Set<string>();
  const re = /agent-resolve\s+([a-zA-Z0-9]{4,16})/gi;
  for (const body of commentBodies) {
    if (!body) continue;
    for (const m of body.matchAll(re)) {
      ids.add(m[1]!.toLowerCase());
    }
  }
  return [...ids];
}

/**
 * Apply human `agent-resolve <id>` commands: move matching open findings to
 * resolved and mute their fingerprints so later re-reports stay suppressed.
 */
export function applyResolvedIds(
  state: PrAgentState,
  ids: string[],
  cycle: number,
): {
  openFindings: Finding[];
  resolvedFindings: Finding[];
  mutedFingerprints: string[];
  changed: boolean;
} {
  const idSet = new Set(ids.map((i) => i.toLowerCase()));
  const toResolve = state.openFindings.filter((f) => idSet.has(f.id.toLowerCase()));
  if (toResolve.length === 0) {
    return {
      openFindings: state.openFindings,
      resolvedFindings: state.resolvedFindings,
      mutedFingerprints: state.mutedFingerprints,
      changed: false,
    };
  }
  const resolveFps = new Set(toResolve.map((f) => f.fingerprint));
  const openFindings = state.openFindings.filter((f) => !resolveFps.has(f.fingerprint));
  const resolvedFindings = [
    ...state.resolvedFindings,
    ...toResolve.map((f) => ({ ...f, status: 'resolved' as const, lastSeenCycle: cycle })),
  ];
  const mutedFingerprints = [...new Set([...state.mutedFingerprints, ...resolveFps])];
  return { openFindings, resolvedFindings, mutedFingerprints, changed: true };
}

export function sourceCounts(findings: Finding[]): Record<ReviewSlot, number> {
  const counts: Record<ReviewSlot, number> = {
    bugbot: 0,
    standards: 0,
    depth: 0,
  };
  for (const f of openBlocking(findings)) {
    const s = f.source as ReviewSlot;
    if (s in counts) counts[s]++;
  }
  return counts;
}

export function parseVerdictFromText(text: string): Verdict | null {
  // Extract every balanced top-level JSON object (string-aware), then return the
  // last one that validates as a verdict. Handles compact, pretty-printed, and
  // fenced (```json) payloads regardless of surrounding prose.
  const candidates = extractJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return VerdictSchema.parse(JSON.parse(candidates[i]!));
    } catch {
      continue;
    }
  }
  return null;
}

function extractJsonObjects(text: string): string[] {
  return extractJsonObjectSpans(text).map((s) => s.json);
}

function extractJsonObjectSpans(text: string): Array<{ json: string; start: number; end: number }> {
  const objects: Array<{ json: string; start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push({ json: text.slice(start, i + 1), start, end: i + 1 });
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Return the human-readable portion of a review by removing the trailing verdict
 * JSON object (and any surrounding ```json fence). Leaves all other prose intact.
 */
export function stripVerdictJson(text: string): string {
  const spans = extractJsonObjectSpans(text);
  for (let i = spans.length - 1; i >= 0; i--) {
    try {
      VerdictSchema.parse(JSON.parse(spans[i]!.json));
    } catch {
      continue;
    }
    const before = text.slice(0, spans[i]!.start).replace(/```(?:json)?\s*$/i, '');
    const after = text.slice(spans[i]!.end).replace(/^\s*```/, '');
    return `${before}${after}`.trim();
  }
  return text.trim();
}
