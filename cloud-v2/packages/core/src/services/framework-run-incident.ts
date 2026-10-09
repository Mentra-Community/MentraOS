import {createHash} from 'node:crypto';
import type {RecordedFrameworkRun} from '../types/framework-run.types';

type Asset = RecordedFrameworkRun['assets'][number];
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The filed app receipt must belong to this run's exact frozen request. */
export function recordedRunIncident(runId: string, requestBytes: Buffer, receiptBytes: Buffer): string | null {
  try {
    const requestFile = object(JSON.parse(requestBytes.toString('utf8')));
    const request = object(requestFile?.request);
    const receipt = object(JSON.parse(receiptBytes.toString('utf8')));
    if (requestFile?.schemaVersion !== 1 || receipt?.schemaVersion !== 1 || request?.test_run_id !== runId
      || receipt.test_run_id !== runId || typeof request.alert_id !== 'string' || !request.alert_id
      || receipt.alert_id !== request.alert_id || receipt.status !== 'filed'
      || receipt.requestFile !== 'incident-report/request.json'
      || receipt.requestSha256 !== createHash('sha256').update(requestBytes).digest('hex')
      || typeof receipt.report_id !== 'string' || !/^rep_[A-Za-z0-9]{1,80}$/.test(receipt.report_id)
      || receipt.incident_id !== receipt.report_id) return null;
    return receipt.report_id;
  } catch {return null;}
}

/** Optional display lookup: two small declared blobs, one deadline; never dispatches reporting. */
export async function readRunIncident(run: RecordedFrameworkRun,
  read: (asset: Asset, signal: AbortSignal) => Promise<Response>): Promise<string | null> {
  const assets = ['incident-report/request.json', 'incident-report/result.json'].map(path => {
    const matches = run.assets.filter(asset => asset.path === path && ['report', 'diagnostic'].includes(asset.kind)
      && asset.mimeType === 'application/json');
    return matches.length === 1 ? matches[0] : undefined;
  });
  if (assets.some(asset => !asset || asset.size < 1 || asset.size > 64 * 1024)) return null;
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReturnType<NonNullable<Response['body']>['getReader']> | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {
    expired = true; controller.abort(); void reader?.cancel().catch(() => {});
    reject(new Error('Incident receipt display read timed out'));
  }, 3000);});
  const bodies: Buffer[] = [];
  try {
    for (const asset of assets) {
      const reading = read(asset!, controller.signal).then(value => {
        if (expired) {void value.body?.cancel().catch(() => {}); throw new Error('Incident receipt read expired');}
        return value;
      });
      response = await Promise.race([reading, deadline]);
      if (response.status !== 200 || !response.body) return null;
      const bodyReader = response.body.getReader();
      reader = bodyReader;
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const {done, value} = await Promise.race([bodyReader.read(), deadline]);
        if (done) break;
        size += value.byteLength;
        if (size > asset!.size) return null;
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== asset!.size || createHash('sha256').update(bytes).digest('hex') !== asset!.sha256) return null;
      bodies.push(bytes); bodyReader.releaseLock(); reader = undefined; response = undefined;
    }
    return expired ? null : recordedRunIncident(run.result.runId, bodies[0]!, bodies[1]!);
  } catch {return null;}
  finally {
    clearTimeout(timer);
    if (reader) {void reader.cancel().catch(() => {}); try {reader.releaseLock();} catch {}}
    else if (response) void response.body?.cancel().catch(() => {});
  }
}
