import {createHash} from 'node:crypto';
import type {FrameworkFailureScreen, RecordedFrameworkRun} from '../types/framework-run.types';

const MAX_DIAGNOSTIC_BYTES = 8 * 1024 ** 2;
type Asset = RecordedFrameworkRun['assets'][number];
type Source = 'app' | 'desktop';
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const rowsOf = (value: unknown): unknown[] => {
  const report = object(value);
  return Array.isArray(value) ? value : Array.isArray(report?.results) ? report.results : Array.isArray(report?.records) ? report.records : [];
};
const isJournal = (path: string) => /^setup-evidence\/mac-commands-[a-f0-9-]{36}\.json$/.test(path);
const isBundle = (path: string) => /^setup-evidence-bundles\/[a-f0-9]{64}\.json$/.test(path);
const image = (asset: Asset) => asset.kind === 'screenshot' && ['image/png', 'image/jpeg'].includes(asset.mimeType);

/** Project only recorded associations to images declared in this same frozen run. */
export function recordedFailureScreens(run: RecordedFrameworkRun, diagnostic: unknown): FrameworkFailureScreen[] {
  const key = (phase: string, actionId: string, message: string) => JSON.stringify([phase, actionId, message]);
  const associations = new Map<string, Record<Source, Set<string>>>();
  const add = (phase: string, actionId: string, message: string, assetId: string, source: Source = 'app') => {
    const identity = key(phase, actionId, message);
    const ids = associations.get(identity) ?? {app: new Set<string>(), desktop: new Set<string>()};
    ids[source].add(assetId); associations.set(identity, ids);
  };
  const addPath = (phase: string, actionId: string, message: string, path: string, source: Source = 'app') => {
    // Only the recorded relative path can identify an image. Absolute paths and nearby filenames have no meaning here.
    const assets = run.assets.filter(asset => asset.path === path && image(asset));
    if (assets.length === 1) add(phase, actionId, message, assets[0]!.id, source);
    else add(phase, actionId, message, '', source);
  };
  for (const value of rowsOf(diagnostic)) {
    const row = object(value);
    if (!row) continue;
    const message = object(row.error)?.message;
    if (run.platform === 'android' && row.command === 'failure' && row.state === 'error' && typeof row.phase === 'string' &&
      typeof row.actionId === 'string' && typeof message === 'string' && typeof row.screenshotAssetId === 'string')
      add(row.phase, row.actionId, message, row.screenshotAssetId);
    if (run.platform !== 'ios-on-mac' || row.privateEvidence) continue;
    // Test failures are associated by the reporter; lifecycle failures by the successful guarded native journal row.
    if (typeof row.id === 'string' && row.status === 'failed' && typeof row.error === 'string' && typeof row.screenshot === 'string')
      addPath('test', row.id, row.error, row.screenshot);
    if (row.command === 'failure-screenshot' && row.state === 'complete' && (row.phase === 'setup' || row.phase === 'teardown') &&
      typeof row.actionId === 'string' && typeof row.message === 'string' && typeof row.screenshotPath === 'string' &&
      (row.source === 'screenshot' || row.source === 'desktop-screenshot'))
      addPath(row.phase, row.actionId, row.message, row.screenshotPath, row.source === 'screenshot' ? 'app' : 'desktop');
  }
  const screens: FrameworkFailureScreen[] = [];
  const resolve = (ids: Set<string> | undefined) => {
    if (!ids || ids.size !== 1) return;
    const id = [...ids][0]!;
    const assets = run.assets.filter(asset => asset.id === id && image(asset));
    return assets.length === 1 ? id : undefined;
  };
  for (const failure of run.result.failures) {
    const ids = associations.get(key(failure.phase, failure.actionId, failure.message));
    const assetId = resolve(ids?.app), desktopAssetId = resolve(ids?.desktop);
    screens.push({phase: failure.phase, actionId: failure.actionId,
      ...(assetId ? {assetId} : {}), ...(desktopAssetId ? {desktopAssetId} : {})});
  }
  // Different recorded failures with the same displayed phase/action cannot silently select an image for either source.
  return screens.filter((screen, index) => screens.findIndex(other => other.phase === screen.phase && other.actionId === screen.actionId) === index)
    .map(screen => {
      const same = screens.filter(other => other.phase === screen.phase && other.actionId === screen.actionId);
      const app = new Set(same.map(other => other.assetId)), desktop = new Set(same.map(other => other.desktopAssetId));
      return {phase: screen.phase, actionId: screen.actionId, ...(app.size === 1 && screen.assetId ? {assetId: screen.assetId} : {}),
        ...(desktop.size === 1 && screen.desktopAssetId ? {desktopAssetId: screen.desktopAssetId} : {})};
    }).filter(screen => screen.assetId || screen.desktopAssetId);
}

export function failureDiagnosticAssets(run: RecordedFrameworkRun): Asset[] {
  if (!run.result.failures.length) return [];
  const lifecycle = run.platform === 'ios-on-mac' && run.result.failures.some(failure => ['setup', 'teardown'].includes(failure.phase));
  return run.assets.filter(asset => ['report', 'diagnostic'].includes(asset.kind) && asset.mimeType === 'application/json' &&
    (run.platform === 'android' ? asset.path === 'setup-evidence/setup-diagnostics.json'
      : (asset.path === 'run.json' && run.result.failures.some(failure => failure.phase === 'test')) || lifecycle && (isJournal(asset.path) || isBundle(asset.path))));
}

function diagnosticRows(asset: Asset, bytes: Buffer): unknown[] {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isBundle(asset.path)) return rowsOf(parsed);
  const bundle = object(parsed);
  if (bundle?.schemaVersion !== 1 || bundle.kind !== 'setup-diagnostic-bundle' || bundle.encoding !== 'base64' ||
    !Array.isArray(bundle.files) || bundle.files.length > 256) throw new Error('Invalid failure diagnostic bundle');
  return bundle.files.flatMap(value => {
    const entry = object(value);
    if (typeof entry?.path !== 'string' || !isJournal(entry.path)) return [];
    if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 1 || Number(entry.size) > MAX_DIAGNOSTIC_BYTES ||
      typeof entry.bytesBase64 !== 'string' || typeof entry.sha256 !== 'string') throw new Error('Invalid failure journal entry');
    const original = Buffer.from(entry.bytesBase64, 'base64');
    if (original.toString('base64') !== entry.bytesBase64 || original.length !== entry.size ||
      createHash('sha256').update(original).digest('hex') !== entry.sha256) throw new Error('Failure journal bytes differ');
    return rowsOf(JSON.parse(original.toString('utf8')));
  });
}

/** All optional display metadata shares one deadline and byte limit; it never changes the verdict. */
export async function readFailureScreens(run: RecordedFrameworkRun, read: (asset: Asset, signal: AbortSignal) => Promise<Response>): Promise<FrameworkFailureScreen[]> {
  const assets = failureDiagnosticAssets(run);
  if (!assets.length || assets.reduce((size, asset) => size + asset.size, 0) > MAX_DIAGNOSTIC_BYTES) return [];
  let response: Response | undefined;
  let reader: ReturnType<NonNullable<Response['body']>['getReader']> | undefined;
  let expired = false;
  const controller = new AbortController();
  const expiresAt = performance.now() + 3000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {
    expired = true;
    controller.abort();
    void reader?.cancel().catch(() => {});
    reject(new Error('Failure image diagnostic read timed out'));
  }, 3000);});
  const rows: unknown[] = [];
  try {
    for (const asset of assets) {
      const reading = read(asset, controller.signal).then(value => {
        if (expired) {void value.body?.cancel().catch(() => {}); throw new Error('Failure image diagnostic read expired');}
        return value;
      });
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
      rows.push(...diagnosticRows(asset, bytes));
      reader.releaseLock(); reader = undefined; response = undefined;
    }
    if (expired || performance.now() >= expiresAt) return [];
    return recordedFailureScreens(run, rows);
  } catch {return [];}
  finally {
    clearTimeout(timer);
    if (reader) {void reader.cancel().catch(() => {}); try {reader.releaseLock();} catch {}}
    else if (response) void response.body?.cancel().catch(() => {});
  }
}
