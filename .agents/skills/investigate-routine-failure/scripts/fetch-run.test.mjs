import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {locateRun, selectToken, boundedGet, fetchRun} from './fetch-run.mjs';
const target=locateRun('https://admin.dev.mentraglass.com/?testRun=request-one');
test('URL pins known Core environment and refuses mismatched or foreign destinations',()=>{
  assert.equal(target.core,'https://core.dev.us-west-2.mentraglass.com');
  for(const value of ['https://evil.test/?testRun=one','https://admin.dev.mentraglass.com/?testRun=a&testRun=b',
    'https://user@admin.dev.mentraglass.com/?testRun=one']) assert.throws(()=>locateRun(value));
  assert.throws(()=>locateRun('https://admin.dev.mentraglass.com/?testRun=one','prod'));
  assert.throws(()=>locateRun('one')); assert.equal(locateRun('one','staging').env,'staging');
});
test('existing environment report credential wins without reading a host credential',()=>{
  assert.equal(selectToken('dev',{MENTRA_ADMIN_TOKEN_DEV:'dev-token',MENTRA_ADMIN_TOKEN:'generic'}),'dev-token');
  assert.equal(selectToken('dev',{MENTRA_ADMIN_TOKEN:'generic'}),'generic');
  assert.throws(()=>selectToken('dev',{MENTRA_ADMIN_TOKEN_PROD:'other'}));
});
test('request evidence is saved without inventing completed execution',async()=>{
  const out=await mkdtemp(join(tmpdir(),'routine-read-'));
  try {
    const receipt=await fetchRun({target,token:'fixture',out,fetcher:async(url,opts)=>{
      assert.equal(url,`${target.core}/api/admin/test-runs/request-one`); assert.equal(opts.redirect,'error');
      assert.equal(opts.headers.Authorization,'Bearer fixture');
      return Response.json({kind:'request',request:{requestId:'request-one',state:'awaiting-runner'}});
    }});
    assert.equal(receipt.kind,'request'); assert.equal(receipt.asset,undefined);
    assert.equal(JSON.parse(await readFile(join(out,'detail.json'))).request.state,'awaiting-runner');
  } finally {await rm(out,{recursive:true});}
});
test('assets use actual run identity and encoded opaque IDs, never declared filesystem paths',async()=>{
  const out=await mkdtemp(join(tmpdir(),'routine-read-')), data=Buffer.from('diagnostic'), id='diagnostics/setup:one';
  const asset={id,path:'../../escape',size:data.length,sha256:createHash('sha256').update(data).digest('hex'),mimeType:'text/plain'};
  const calls=[];
  try {
    const receipt=await fetchRun({target,token:'fixture',out,assetId:id,fetcher:async url=>{
      calls.push(url); return calls.length===1?Response.json({kind:'run',run:{requestId:target.id,result:{runId:'actual-run'},assets:[asset]},uploadsComplete:true}):new Response(data);
    }});
    assert.equal(calls[1],`${target.core}/api/admin/test-runs/actual-run/assets/diagnostics%2Fsetup%3Aone`);
    assert.deepEqual(await readFile(join(out,receipt.asset.filename)),data);
    assert.equal(JSON.stringify(receipt).includes('fixture'),false);
  } finally {await rm(out,{recursive:true});}
});
test('size bounds cancel an oversized stream and auth errors omit raw response bodies',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(5));},cancel(){cancelled=true;}});
  await assert.rejects(boundedGet('https://example.test','fixture',4,async()=>new Response(stream)),/byte limit/);
  assert.equal(cancelled,true);
  for(const status of [401,403,404,503]) await assert.rejects(
    boundedGet('https://example.test','fixture',4,async()=>new Response('secret response',{status})),error=>error.message.includes(`HTTP ${status}`)&&!error.message.includes('secret'));
});
test('mismatched assets are not written and foreign results are rejected',async()=>{
  const out=await mkdtemp(join(tmpdir(),'routine-read-'));
  try {
    await assert.rejects(fetchRun({target,token:'fixture',out,fetcher:async()=>Response.json({kind:'run',run:{requestId:'foreign',result:{runId:'foreign'},assets:[]}})}),/identity differs/);
    let calls=0;
    await assert.rejects(fetchRun({target,token:'fixture',out,assetId:'log',fetcher:async()=>++calls===1?Response.json({kind:'run',run:{requestId:target.id,result:{runId:'actual-run'},assets:[{id:'log',size:3,sha256:'a'.repeat(64)}]}}):new Response('bad')}),/digest differs/);
  } finally {await rm(out,{recursive:true});}
});
test('malformed successful response does not expose private contents in error output',async()=>{
  const out=await mkdtemp(join(tmpdir(),'routine-read-'));
  try {
    await assert.rejects(fetchRun({target,token:'fixture',out,fetcher:async()=>new Response('private transcript not JSON')}),
      error=>error.message.includes('valid JSON')&&!error.message.includes('private transcript'));
  } finally {await rm(out,{recursive:true});}
});
