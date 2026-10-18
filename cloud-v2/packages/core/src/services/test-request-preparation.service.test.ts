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
test('an unrelated fixture capability does not require its offered Google exclusive dependency',async()=>{
  const dependency={resourceId:'conference-account',authorityHostId:'mini',capability:'google-authentication'},
    selected={...intent,platform:'ios-on-mac' as const,laneId:'mac'}, prepared={...input,platform:selected.platform,laneId:selected.laneId,
      resources:[{id:'fixtures',kind:'fixture-data',exclusiveDependencies:[dependency]}]},
    row={requestId:selected.requestId,hostId:'mini',state:'preparing',dispatchIntent:selected,dispatchIntentSha256:requestInputDigest(selected),
      fleetSelection:{requestId:selected.requestId},fleetPreparation:{requirements:{resources:[{kind:'fixture-data',capabilities:['clipboard']}]}},
      fleetResourceAdmission:{intent:{operationId:`run:${selected.requestId}`,hostId:'mini',laneId:'mac',owner:{id:selected.requestId,kind:'run' as const},
        inputSha256:'f'.repeat(64),controller:{incarnation:'selected',generation:1,sequence:7},resources:[{id:'fixtures',capabilities:['clipboard']}]},dependencies:[]}}
  const find=spyOn(TestRequestModel,'findOne').mockReturnValue({read(){return this},readConcern(){return this},lean:async()=>row} as any)
  const cas=spyOn(TestRequestModel.collection,'findOneAndUpdate').mockResolvedValue({...row,state:'queued',input:prepared,inputSha256:requestInputDigest(prepared)} as any)
  try{
    const service=new TestRequestService(undefined,undefined,null)
    expect((await service.completePreparation(selected.requestId,'mini',row.dispatchIntentSha256,prepared)).state).toBe('queued')
    row.fleetPreparation.requirements.resources[0]!.capabilities=['google-authentication']
    row.fleetResourceAdmission.intent.resources[0]!.capabilities=['google-authentication']
    await expect(service.completePreparation(selected.requestId,'mini',row.dispatchIntentSha256,prepared)).rejects.toThrow('staged fleet admission')
    expect(cas).toHaveBeenCalledTimes(1)
  }finally{find.mockRestore();cas.mockRestore()}
});
test('fleet executable preparation cannot bypass a nonempty frozen admission by omitting dependency metadata',async()=>{
  const dependency={resourceId:'conference-account',authorityHostId:'mini',capability:'google-authentication'},
    selected={...intent,platform:'ios-on-mac' as const,laneId:'mac'},prepared={...input,platform:selected.platform,laneId:selected.laneId,
      resources:[{id:'fixtures',kind:'fixture-data'}]},
    admission={intent:{operationId:`run:${selected.requestId}`,hostId:'mini',laneId:'mac',owner:{id:selected.requestId,kind:'run' as const},
      inputSha256:'f'.repeat(64),controller:{incarnation:'selected',generation:1,sequence:7},resources:[{id:'fixtures',capabilities:['google-authentication']}]},dependencies:[dependency]},
    row={requestId:selected.requestId,hostId:'mini',state:'preparing',dispatchIntent:selected,dispatchIntentSha256:requestInputDigest(selected),
      fleetSelection:{requestId:selected.requestId},fleetResourceAdmission:admission}
  const find=spyOn(TestRequestModel,'findOne').mockReturnValue({read(){return this},readConcern(){return this},lean:async()=>row} as any),
    cas=spyOn(TestRequestModel.collection,'findOneAndUpdate').mockResolvedValue(null as any)
  try{
    await expect(new TestRequestService(undefined,undefined,null).completePreparation(selected.requestId,'mini',row.dispatchIntentSha256,prepared))
      .rejects.toThrow('staged fleet admission')
    expect(cas).not.toHaveBeenCalled();expect(row).not.toHaveProperty('input')
  }finally{find.mockRestore();cas.mockRestore()}
})


test('ordinary preparation polls yield beyond one hundred waiting sources without changing their intent',async()=>{
  const rows=Array.from({length:102},(_,index)=>{const selected={...intent,requestId:`source-${String(index).padStart(3,'0')}`};return {requestId:selected.requestId,hostId:'mini',state:'preparing',dispatchIntent:selected,dispatchIntentSha256:requestInputDigest(selected),createdAt:new Date(index),preparationCheckedAt:undefined as Date|undefined}});
  const digests=rows.map(row=>row.dispatchIntentSha256);let sort:unknown,limit=0;
  const find=spyOn(TestRequestModel,'find').mockImplementation(((query:any)=>({
    sort(value:unknown){sort=value;return this},limit(value:number){limit=value;return this},read(){return this},readConcern(){return this},
    async lean(){if(query.state==='queued')return [];return rows.filter(row=>row.hostId===query.hostId&&row.state===query.state).sort((left,right)=>(left.preparationCheckedAt?.valueOf()??0)-(right.preparationCheckedAt?.valueOf()??0)||left.createdAt.valueOf()-right.createdAt.valueOf()||left.requestId.localeCompare(right.requestId)).slice(0,limit).map(row=>structuredClone(row))},
  }) as any) as any);
  const update=spyOn(TestRequestModel,'updateMany').mockImplementation((async(query:any,value:any)=>{for(const row of rows)if(row.hostId===query.hostId&&row.state===query.state&&query.requestId.$in.includes(row.requestId))row.preparationCheckedAt=value.$set.preparationCheckedAt;return {matchedCount:query.requestId.$in.length} as any}) as any);
  try {
    const service=new TestRequestService(undefined,undefined,null,null);
    const first=await service.queued('mini',undefined,100);expect(first.preparations).toHaveLength(100);expect(first.preparations.some(row=>row.requestId==='source-101')).toBe(false);
    const second=await service.queued('mini',undefined,100);expect(second.preparations.some(row=>row.requestId==='source-101')).toBe(true);
    expect(sort).toEqual({preparationCheckedAt:1,createdAt:1,requestId:1});expect(rows.map(row=>row.dispatchIntentSha256)).toEqual(digests);
    expect(update.mock.calls[0]?.[0]).toMatchObject({hostId:'mini',state:'preparing'});expect(update.mock.calls[0]?.[2]).toMatchObject({writeConcern:{w:'majority',j:true}});
  } finally {find.mockRestore();update.mockRestore()}
});
