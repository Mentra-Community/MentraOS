import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rerunSelection,dispatchRerun} from './rerun-device-routines.mjs';
const inputs={parent_suite_id:'nightly',statuses:'failed,setup-failed',reason:'Verify repair'};
test('manual selection defaults to original artifacts and supports an exact optional replacement',()=>{
 assert.equal(rerunSelection(inputs).source,undefined);
 assert.deepEqual(rerunSelection({...inputs,channel:'pr',build_run_id:'123',publication_attempt:'2',pr_number:'45'}).source,{channel:'pr',buildRunId:123,publicationAttempt:2,prNumber:45});
 assert.throws(()=>rerunSelection({...inputs,member_ids:'one'}));assert.throws(()=>rerunSelection({...inputs,channel:'dev',build_run_id:'latest'}));
});
test('workflow retries reuse the run identity and submit only the server preview digest',async()=>{
 const bodies=[];const fetchImpl=async(url,options)=>{bodies.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>url.endsWith('/preview')?{previewDigest:'digest'}:{admissions:[]}}};
 const options={inputs,runId:123,token:'capability',fetchImpl};await dispatchRerun(options);await dispatchRerun(options);
 assert.equal(bodies[0].body.rerunId,bodies[2].body.rerunId);assert.deepEqual(bodies[1].body,{rerunId:'manual-rerun-123',previewDigest:'digest'});assert.equal(bodies[0].body.source,undefined);
});
