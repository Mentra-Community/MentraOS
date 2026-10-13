import {expect,spyOn,test} from 'bun:test'
import {RoutineCaseOriginalService} from './routine-case-original.service'
import {TestRequestModel} from '../models/test-request.model'
import {requestInputDigest} from './test-request.service'
const nativeInput={routineId:'camera',platform:'android',definitionRevision:'a'.repeat(40),laneId:'android',resources:[],build:{repository:'Mentra-Community/MentraOS',channel:'dev',headSha:'b'.repeat(40)}}
const chain=(value:unknown)=>({read(){return this},readConcern(){return this},setOptions(){return this},async lean(){return value}})
test('successor resolution preserves failed original suite lineage and original source branch, not fixing PR branch',async()=>{
 const find=spyOn(TestRequestModel,'findOne').mockImplementation(({requestId}:any)=>chain({requestId,input:nativeInput,inputSha256:requestInputDigest(nativeInput)}) as any)
 try {
  const reruns={async lineage(){return{lineage:{parent:{suiteId:'suite'},memberId:'member'}}},async originalMembers(){return[{requestId:'original',memberId:'member',routineId:'camera',platform:'android',status:'failed',runId:'original'}]}}
  const service=new RoutineCaseOriginalService(reruns as any,{} as any,()=> 'dev'),row=await service.original('successor')
  expect(row.original.requestId).toBe('original');expect(row.original.suiteId).toBe('suite');expect(row.anchorRunId).toBe('original');expect(row.original.branch).toBe('dev')
  expect(row.original.headSha).toBe(nativeInput.build.headSha);expect(row.original.environment).toBe('dev')
 }finally{find.mockRestore()}
})
test('linked publication needs same occurrence platform/routine and backend environment; incomplete evidence is not verified',async()=>{
 const find=spyOn(TestRequestModel,'findOne').mockImplementation(()=>chain({requestId:'successor'}) as any)
 try {
  const reruns={async lineage(){return{lineage:{parent:{requestId:'original'},memberId:'original'}}}}
  const original={occurrenceId:'tfo_orig',rootKey:requestInputDigest({parent:{requestId:'original'},memberId:'original'}),anchorRunId:'original',verificationRequestIds:[],
    original:{requestId:'original',memberId:'original',routineId:'camera',platform:'android',environment:'dev',repository:'Mentra-Community/MentraOS',channel:'dev',branch:'dev',branchKey:'a'.repeat(64)}} as const
  const service=new RoutineCaseOriginalService(reruns as any,{async summary(){return{routineId:'camera',platform:'android',outcome:'pass',uploadsComplete:true,evidenceStatus:'failed'}}} as any,()=> 'dev')
  expect((await service.verify({...original,verificationRequestIds:[]},'successor')).passed).toBe(false)
  await expect(new RoutineCaseOriginalService(reruns as any,{} as any,()=> 'staging').verify({...original,verificationRequestIds:[]},'successor')).rejects.toThrow('environment')
 }finally{find.mockRestore()}
})
