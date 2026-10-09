import {createHash} from 'node:crypto';
import type {FrameworkFailureScreen, RecordedFrameworkRun} from '../types/framework-run.types';

const MAX_DIAGNOSTIC_BYTES = 8 * 1024 ** 2;
type Asset = RecordedFrameworkRun['assets'][number];
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Project only a recorded association to an image declared in this same frozen run. */
export function recordedFailureScreens(run: RecordedFrameworkRun, diagnostic: unknown): FrameworkFailureScreen[] {
  const report = object(diagnostic);
  const rows = Array.isArray(diagnostic) ? diagnostic : Array.isArray(report?.results) ? report.results : [];
  const key = (phase: string, actionId: string, message: string) => JSON.stringify([phase, actionId, message]);
  const associations = new Map<string, Set<string>>();
  const add = (phase: string, actionId: string, message: string, assetId: string) => {
    const identity = key(phase, actionId, message);
    const ids = associations.get(identity) ?? new Set<string>();
    ids.add(assetId); associations.set(identity, ids);
  };
  for (const value of rows) {
    const row = object(value);
    if (!row) continue;
    const message = object(row.error)?.message;
    if (run.platform === 'android' && row.command === 'failure' && row.state === 'error' && typeof row.phase === 'string' &&
      typeof row.actionId === 'string' && typeof message === 'string' && typeof row.screenshotAssetId === 'string')
      add(row.phase, row.actionId, message, row.screenshotAssetId);
    // The Mac reporter records the exact relative screenshot path on its failed result.
    if (run.platform === 'ios-on-mac' && !row.privateEvidence && typeof row.id === 'string' && row.status === 'failed' &&
      typeof row.error === 'string' && typeof row.screenshot === 'string') {
      const assets = run.assets.filter(asset => asset.path === row.screenshot && asset.kind === 'screenshot');
      if (assets.length === 1) add('test', row.id, row.error, assets[0]!.id);
    }
  }
  const screens: FrameworkFailureScreen[] = [];
  for (const failure of run.result.failures) {
    const ids = associations.get(key(failure.phase, failure.actionId, failure.message));
    if (!ids || ids.size !== 1) continue;
    const declared = [...ids].filter(id => run.assets.some(asset => asset.id === id && asset.kind === 'screenshot' &&
      ['image/png', 'image/jpeg'].includes(asset.mimeType)));
    // Conflicting associations cannot silently pick an arbitrary image.
    if (declared.length === 1) screens.push({phase: failure.phase, actionId: failure.actionId, assetId: declared[0]!});
  }
  return screens.filter((screen, index) => screens.findIndex(other => other.phase === screen.phase && other.actionId === screen.actionId) === index
    && !screens.some(other => other.phase === screen.phase && other.actionId === screen.actionId && other.assetId !== screen.assetId));
}

export function failureDiagnosticAsset(run: RecordedFrameworkRun): Asset | undefined {
  if (!run.result.failures.length) return;
  const path = run.platform === 'android' ? 'setup-evidence/setup-diagnostics.json' : 'run.json';
  return run.assets.find(asset => asset.path === path && ['report', 'diagnostic'].includes(asset.kind) &&
    asset.mimeType === 'application/json' && asset.size <= MAX_DIAGNOSTIC_BYTES);
}

/** Optional display evidence is bounded and digest checked; it never changes the verdict. */
export async function readFailureScreens(run: RecordedFrameworkRun, read: (asset: Asset) => Promise<Response>): Promise<FrameworkFailureScreen[]> {
  const asset = failureDiagnosticAsset(run);
  if (!asset) return [];
  let response: Response | undefined;
  let reader: ReturnType<NonNullable<Response['body']>['getReader']> | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {
    expired = true;
    void reader?.cancel().catch(() => {});
    reject(new Error('Failure image diagnostic read timed out'));
  }, 3000);});
  const reading = read(asset).then(value => {
    if (expired) {void value.body?.cancel().catch(() => {}); throw new Error('Failure image diagnostic read expired');}
    return value;
  });
  try {
    response = await Promise.race([reading, deadline]);
    if (response.status !== 200 || !response.body) return [];
    const bodyReader = response.body.getReader();
    reader = bodyReader;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const {done, value} = await Promise.race([bodyReader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > asset.size) return [];
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) return [];
    return recordedFailureScreens(run, JSON.parse(bytes.toString('utf8')));
  } catch {return [];}
  finally {
    clearTimeout(timer);
    if (reader) {void reader.cancel().catch(() => {}); try {reader.releaseLock();} catch {}}
    else if (response) void response.body?.cancel().catch(() => {});
  }
}
