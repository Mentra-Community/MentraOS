import {expect, spyOn, test} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {testRoutineSource} from '../testing/framework-fixtures';
import {requestInputDigest, TestRequestService, type StoredPreparingRequest, type StoredRequest, type TestRequestRepository} from './test-request.service';
const build={repository:'Mentra-Community/MentraOS',headSha:'c'.repeat(40),channel:'dev' as const,kind:'android-apk',source:{channel:'dev' as const,buildRunId:1,publicationAttempt:1},archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',size:10,sha256:'d'.repeat(64)},receipt:{url:'https://artifactscdn.mentraglass.com/receipt',size:2,sha256:'e'.repeat(64)}};
const intent={requestId:'prepare-1',routineId:'sample',platform:'android' as const,routineRevision:'a'.repeat(40),laneId:'android',source:build.source,build};
const input={routineId:intent.routineId,platform:intent.platform,definitionRevision:intent.routineRevision,routineSource:testRoutineSource(),laneId:intent.laneId,build,resources:[{id:'app',kind:'app'}]};
function repository() {
  let row:StoredRequest|null=null;
  const store:TestRequestRepository={async insert(){throw Error('unused')},async get(){return structuredClone(row)},async accept(){return null},async reject(){return null},async cancel(){return null},async acknowledgeCancellation(){return null},async queued(){return []},async cancellations(){return []},
    async insertPreparation(value){if(row)throw Object.assign(Error('duplicate'),{code:11000});row=structuredClone(value)},
    async completePreparation(id,host,digest,prepared,inputSha256){if(row?.state!=='preparing')return null;row={...row,state:'queued',input:prepared,inputSha256};return structuredClone(row)},
    async cancelPreparation(id,digest,value){if(row?.state!=='preparing')return null;row={...row,state:'terminal',terminalStatus:'cancelled',preparationCancellation:value} as StoredPreparingRequest;return structuredClone(row) as StoredPreparingRequest},
  };return store;
}
test('concurrent different prepared inputs cannot borrow one winning CAS input',async()=>{
  const store=repository(),service=new TestRequestService(store),row=await service.prepare('mini',intent);
  const settled=await Promise.allSettled([service.completePreparation(intent.requestId,'mini',row.dispatchIntentSha256!,input),
    service.completePreparation(intent.requestId,'mini',row.dispatchIntentSha256!,{...input,resources:[{id:'different-app',kind:'app'}]})]);
  expect(settled.map(value=>value.status)).toEqual(['fulfilled','rejected']);
  expect((await service.get(intent.requestId))?.inputSha256).toBe(requestInputDigest(input));
});
test('cancel-before-first-preparation persists and prevents a later insertion after restart',async()=>{
  const store=repository(),service=new TestRequestService(store);
  const cancelled=await service.cancelPreparationSubmission(intent.requestId,'mini',intent,'2026-10-06T12:00:00Z','Boundary');
  const restarted=new TestRequestService(store);expect(await restarted.prepare('mini',intent)).toEqual(cancelled);
  expect(await restarted.completePreparation(intent.requestId,'mini',cancelled.dispatchIntentSha256!,input)).toEqual(cancelled);
  expect(cancelled).not.toHaveProperty('input');expect(cancelled).not.toHaveProperty('hostReceipt');
});
test('Mongo completion uses one absent-input CAS and preserves immutable selection',async()=>{
  const row={requestId:intent.requestId,hostId:'mini',state:'preparing',dispatchIntent:intent,dispatchIntentSha256:requestInputDigest(intent)};
  const find=spyOn(TestRequestModel,'findOne').mockReturnValue({read(){return this},readConcern(){return this},lean:async()=>row} as any);
  const cas=spyOn(TestRequestModel.collection,'findOneAndUpdate').mockResolvedValue({...row,state:'queued',input,inputSha256:requestInputDigest(input)} as any);
  try {
    const service=new TestRequestService(undefined,undefined,null);await service.completePreparation(intent.requestId,'mini',row.dispatchIntentSha256,input);
    expect(cas.mock.calls[0]?.[0]).toMatchObject({requestId:intent.requestId,hostId:'mini',dispatchIntentSha256:row.dispatchIntentSha256,state:'preparing',input:{$exists:false},inputSha256:{$exists:false},preparationCancellation:{$exists:false},preparationRejection:{$exists:false}});
    expect(cas.mock.calls[0]?.[1]).toMatchObject({$set:{state:'queued',input,inputSha256:requestInputDigest(input)}});
    expect((cas.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({returnDocument:'after',writeConcern:{w:'majority',j:true}});
  }finally{find.mockRestore();cas.mockRestore()}
});
