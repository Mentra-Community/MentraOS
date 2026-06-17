import { createHash } from 'node:crypto';
import { VerdictSchema, type Finding, type ReviewSlot, type Verdict } from './types.js';

export function fingerprintFinding(file: string, message: string): string {
  const category = categorize(message);
  const normalizedFile = file.replace(/\\/g, '/').toLowerCase();
  return `${normalizedFile}:${category}`;
}

function categorize(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('thread') || m.includes('main thread')) return 'thread-safety';
  if (m.includes('null') || m.includes('npe')) return 'null-safety';
  if (m.includes('test')) return 'tests';
  if (m.includes('security') || m.includes('secret')) return 'security';
  if (m.includes('memory') || m.includes('leak')) return 'memory';
  if (m.includes('race')) return 'race';
  return createHash('sha1').update(m.slice(0, 80)).digest('hex').slice(0, 8);
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
      prev.lastSeenCycle = cycle;
      prev.message = f.message;
      if (f.line) prev.line = f.line;
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

export function openBlocking(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'blocking' && f.status === 'open');
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
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      return VerdictSchema.parse(JSON.parse(line));
    } catch {
      continue;
    }
  }
  const match = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (!match) return null;
  try {
    return VerdictSchema.parse(JSON.parse(match[0]));
  } catch {
    return null;
  }
}
