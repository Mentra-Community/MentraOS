import {expect,test} from 'bun:test'
import mongoose from 'mongoose'
import {randomUUID} from 'node:crypto'
import {RoutineCaseService} from './routine-case.service'
import {routineCaseRepository} from './routine-case.repository'
import {RoutineCaseModel,RoutineCaseActivityModel,ensureRoutineCaseIndexes} from '../models/routine-case.model'
const uri=process.env.ROUTINE_CASE_MONGO_URI
;(uri?test:test.skip)('real Mongo transaction enforces one original, append-only revision receipt and claim generation',async()=>{
 if(!uri?.startsWith('mongodb://127.0.0.1:'))throw Error('Only explicit loopback integration allowed')
 await mongoose.connect(uri,{autoIndex:false,dbName:`case_test_${randomUUID().replaceAll('-','')}`})
 try {
  const occurrence={occurrenceId:'tfo_original',rootKey:'a'.repeat(64),anchorRunId:'original',original:{requestId:'original',memberId:'original',routineId:'camera',platform:'android',environment:'dev',repository:'Mentra-Community/MentraOS',channel:'dev' as const,branch:'dev',headSha:'a'.repeat(40),branchKey:'b'.repeat(64)},verificationRequestIds:[]}
  const service=new RoutineCaseService(routineCaseRepository,{async write(){return{key:'testing/case',sha256:'c'.repeat(64),sizeBytes:1}}},undefined,Date.now,()=>true)
  const actor={kind:'operator' as const,id:'test-employee'},results=await Promise.allSettled([service.create(occurrence,randomUUID(),actor),service.create(occurrence,randomUUID(),actor)])
  const indexes=await RoutineCaseModel.collection.listIndexes().toArray()
  expect(indexes.some(index=>index.unique&&index.key.rootKeys===1)).toBe(true)
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await RoutineCaseModel.countDocuments()).toBe(1)
  const row=await RoutineCaseModel.findOne().lean(),id=row!.caseId,originalRevision=row!.revision
  const update={mutationId:randomUUID(),revision:originalRevision,nextAction:'Inspect screenshot and logs'}
  await service.update(id,update,actor);await service.update(id,update,actor)
  expect(await RoutineCaseActivityModel.countDocuments()).toBe(2);expect((await RoutineCaseActivityModel.findOne({mutationId:update.mutationId}).lean())?.detail?.sha256).toBe('c'.repeat(64))
  const current=(await service.detail(id)).case
  await service.claim(id,{action:'acquire',mutationId:randomUUID(),revision:current.revision,generation:1,anchorRunId:'original',branchKey:'b'.repeat(64),token:'T'.repeat(40),ttlSeconds:300},'mini')
  await expect(service.update(id,{mutationId:randomUUID(),revision:current.revision+1,nextAction:'Stale agent'},{kind:'agent',id:'air',token:'T'.repeat(40),generation:1,anchorRunId:'original',branchKey:'b'.repeat(64)})).rejects.toThrow('stale')
 }finally{await mongoose.connection.dropDatabase();await mongoose.disconnect()}
})

;(uri?test:test.skip)('invalid pre-existing authority data fails index readiness closed before a case write',async()=>{
 if(!uri?.startsWith('mongodb://127.0.0.1:'))throw Error('Only explicit loopback integration allowed')
 await mongoose.connect(uri,{autoIndex:false,dbName:`case_index_test_${randomUUID().replaceAll('-','')}`})
 try {
  await RoutineCaseModel.createCollection()
  await RoutineCaseModel.collection.insertMany([{caseId:'one',rootKeys:['same']},{caseId:'two',rootKeys:['same']}])
  await expect(ensureRoutineCaseIndexes()).rejects.toThrow()
  await expect(routineCaseRepository.commit(null,{} as never,{} as never)).rejects.toThrow('indexes are not ready')
  expect(await RoutineCaseModel.countDocuments()).toBe(2)
  expect(await RoutineCaseActivityModel.countDocuments()).toBe(0)
 }finally{await mongoose.connection.dropDatabase();await mongoose.disconnect()}
})
