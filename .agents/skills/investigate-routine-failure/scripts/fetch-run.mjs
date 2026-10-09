#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

const origins = {
  dev: {admin: 'admin.dev.mentraglass.com', core: 'https://core.dev.us-west-2.mentraglass.com'},
  staging: {admin: 'admin.staging.mentraglass.com', core: 'https://core.staging.us-west-2.mentraglass.com'},
  prod: {admin: 'admin.mentraglass.com', core: 'https://core.mentraglass.com'},
};
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value);
export function locateRun(value, environment) {
  if (value.startsWith('https://')) {
    const url = new URL(value), match = Object.entries(origins).find(([, target]) => url.hostname === target.admin);
    if (!match || url.port || url.username || url.password || url.pathname !== '/' || url.searchParams.getAll('testRun').length !== 1)
      throw Error('Use a Mentra Admin URL with exactly one testRun selector.');
    const [env, target] = match, id = url.searchParams.get('testRun');
    if (environment && environment !== env) throw Error('--env conflicts with the Admin URL.');
    if (!identity(id)) throw Error('Invalid run/request identity.');
    return {env, id, core: target.core};
  }
  if (!origins[environment] || !identity(value)) throw Error('A bare run/request ID requires --env dev|staging|prod.');
  return {env: environment, id: value, core: origins[environment].core};
}
export function selectToken(env, vars) {
  const name = `MENTRA_ADMIN_TOKEN_${env.toUpperCase()}`;
  const token = vars[name] || vars.MENTRA_ADMIN_TOKEN;
  if (!token || /[\r\n]/.test(token)) throw Error(`Configure ${name} or MENTRA_ADMIN_TOKEN privately; reuse the incident-report admin token.`);
  return token;
}
export async function boundedGet(url, token, limit, fetcher = fetch) {
  const response = await fetcher(url, {headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'},
    redirect: 'error', signal: AbortSignal.timeout(60_000)});
  if (!response.ok) {
    await response.body?.cancel();
    const reason = {401: 'credential rejected', 403: 'credential is not admin-allowlisted',
      404: 'wrong identity/environment, unpublished result, or endpoint not deployed', 503: 'backend temporarily unavailable'}[response.status];
    throw Error(`HTTP ${response.status}: ${reason ?? 'evidence request failed'}.`);
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw Error('Evidence exceeds the requested byte limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function verifyAsset(bytes, asset) {
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
    bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw Error('Asset size/digest differs from the declared run manifest.');
}
export async function fetchRun({target, token, out, assetId, maxBytes = 8 * 1024 * 1024, fetcher = fetch}) {
  const endpoint = `${target.core}/api/admin/test-runs/${encodeURIComponent(target.id)}`;
  const bytes = await boundedGet(endpoint, token, 8 * 1024 * 1024, fetcher);
  let detail;
  try {detail = JSON.parse(bytes.toString());}
  catch {throw Error("Result endpoint did not return valid JSON; no response contents displayed.");}
  if (!detail || typeof detail !== "object") throw Error("Unexpected result envelope.");
  if (detail.kind !== 'run' && detail.kind !== 'request') throw Error('Unexpected result envelope; inspect the current API schema.');
  if (detail.kind === 'request' ? detail.request?.requestId !== target.id :
    !identity(detail.run?.result?.runId) || ![detail.run.result.runId, detail.run.requestId].includes(target.id))
    throw Error('Returned run/request identity differs from the selected link.');
  await mkdir(out, {recursive: true, mode: 0o700});
  await writeFile(join(out, 'detail.json'), bytes, {mode: 0o600});
  const receipt = {environment: target.env, selector: target.id, endpoint, fetchedAt: new Date().toISOString(),
    detailSha256: createHash('sha256').update(bytes).digest('hex'), kind: detail.kind, uploadsComplete: detail.uploadsComplete};
  if (assetId) {
    if (detail.kind !== 'run') throw Error('This is a pending request, not a published run with assets.');
    const matches = detail.run.assets?.filter(asset => asset.id === assetId) ?? [];
    if (matches.length !== 1) throw Error('Asset ID is not uniquely declared in this run manifest.');
    const asset = matches[0];
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes) throw Error('Declared asset exceeds --max-bytes.');
    // Admin media route resolves the actual run ID, which may differ from the request selector.
    const assetEndpoint = `${target.core}/api/admin/test-runs/${encodeURIComponent(detail.run.result.runId)}/assets/${encodeURIComponent(assetId)}`;
    const data = await boundedGet(assetEndpoint, token, Math.min(maxBytes, asset.size), fetcher);
    verifyAsset(data, asset);
    const filename = `asset-${createHash('sha256').update(assetId).digest('hex').slice(0, 24)}`;
    await writeFile(join(out, filename), data, {mode: 0o600});
    receipt.asset = {id: assetId, endpoint: assetEndpoint, filename, sha256: asset.sha256, size: asset.size, mimeType: asset.mimeType};
  }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), {mode: 0o600});
  return receipt;
}
const help = `Usage: node .agents/skills/investigate-routine-failure/scripts/fetch-run.mjs ADMIN_RUN_URL [options]
       node .agents/skills/investigate-routine-failure/scripts/fetch-run.mjs RUN_ID --env dev|staging|prod [options]
Options: --out DIR   (default: incident-logs/routine-runs/ENV/ID)
         --asset ID  (one exact ID from detail.json's run.assets)
         --max-bytes N (asset limit; default 8388608, maximum 2147483648)
         --help
Reads MENTRA_ADMIN_TOKEN_ENV or MENTRA_ADMIN_TOKEN, the incident-report admin credential.
GET only. Pins Core to the Admin URL environment; ignores MENTRA_CORE_URL.
Saves private detail/receipt locally; prints only environment, kind and output directory.`;
export async function main(args, vars = process.env) {
  if (args.includes('--help')) {console.log(help); return;}
  let value, env, out, assetId, maxBytes;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--env','--out','--asset','--max-bytes'].includes(arg)) {
      const next = args[++i]; if (!next || next.startsWith('--')) throw Error(`${arg} requires a value.`);
      if (arg === '--env') env = next;
      else if (arg === '--out') out = next;
      else if (arg === '--asset') assetId = next;
      else maxBytes = Number(next);
    } else if (arg.startsWith('--') || value) throw Error('Unexpected argument; use --help.');
    else value = arg;
  }
  if (!value) throw Error('Provide an Admin run URL or run/request ID; use --help.');
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 ** 3)) throw Error('Invalid --max-bytes.');
  const target = locateRun(value, env), token = selectToken(target.env, vars);
  const directory = resolve(out ?? join('incident-logs','routine-runs',target.env,target.id));
  const result = await fetchRun({target, token, out: directory, assetId, maxBytes});
  console.log(`${result.environment}: ${result.kind}; evidence saved to ${directory}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {console.error(error.message); process.exitCode = 1;});
