import {afterEach, expect, spyOn, test} from 'bun:test'
import {PrRoutineCheckModel} from '../models/pr-routine-check.model'
import {prRoutineCheckRepository} from './pr-routine-check.repository'
import type {PrRoutineCheck, PrRoutineCheckRow} from '../types/pr-routine-check.types'
const spies: Array<{mockRestore():void}>=[]
afterEach(()=>{for(const spy of spies.splice(0))spy.mockRestore()})
const row:PrRoutineCheckRow={gateId:'gate',revision:7,payload:{} as PrRoutineCheck,lease:{id:'lease',expiresAt:new Date('2100-01-01')}}
test('parking removes nextAt under the current revision and live lease without changing custody fields', async()=>{
 const update=spyOn(PrRoutineCheckModel,'updateOne').mockResolvedValue({modifiedCount:1} as never);spies.push(update)
 expect(await prRoutineCheckRepository.save(row,row.payload,null)).toBe(true)
 const [filter,change,options]=update.mock.calls[0] as any
 expect(filter).toMatchObject({gateId:'gate',revision:7,'lease.id':'lease'});expect(filter['lease.expiresAt'].$gt).toBeInstanceOf(Date)
 expect(change).toEqual({$set:{payload:row.payload},$inc:{revision:1},$unset:{lease:1,nextAt:1}});expect(options.timeoutMS).toBe(10000)
})
test('pending work retains a finite due date and no stale payload writer bypasses the CAS',async()=>{
 const update=spyOn(PrRoutineCheckModel,'updateOne').mockResolvedValue({modifiedCount:0} as never);spies.push(update)
 const at=new Date();expect(await prRoutineCheckRepository.save(row,row.payload,at)).toBe(false)
 expect((update.mock.calls as unknown[][])[0]![1]).toEqual({$set:{payload:row.payload,nextAt:at},$inc:{revision:1},$unset:{lease:1}})
})
test('due inventory excludes parked history and stays bounded to twenty earliest current schedules',async()=>{
 const chain={select:(_value:unknown)=>chain,sort:(_value:unknown)=>chain,limit:(_value:unknown)=>chain,read:(_value:unknown)=>chain,readConcern:(_value:unknown)=>chain,setOptions:(_value:unknown)=>chain,lean:async()=>[{gateId:'current'}]}
 const find=spyOn(PrRoutineCheckModel,'find').mockReturnValue(chain as never),limit=spyOn(chain,'limit'),sort=spyOn(chain,'sort'),options=spyOn(chain,'setOptions');spies.push(find,limit,sort,options)
 const now=new Date();expect(await prRoutineCheckRepository.due(now)).toEqual(['current'])
 expect((find.mock.calls as unknown[][])[0]![0]).toEqual({nextAt:{$exists:true,$lte:now}});expect(limit.mock.calls[0]).toEqual([20]);expect(sort.mock.calls[0]).toEqual([{nextAt:1}]);expect(options.mock.calls[0]).toEqual([{timeoutMS:10000}])
})
test('event wake uses the same nextAt field and cannot postpone already due work',async()=>{
 const update=spyOn(PrRoutineCheckModel,'updateOne').mockResolvedValue({modifiedCount:1} as never);spies.push(update)
 const at=new Date();await prRoutineCheckRepository.wake('gate',at)
 expect((update.mock.calls as unknown[][])[0]![0]).toEqual({gateId:'gate'});expect((update.mock.calls as unknown[][])[0]![1]).toEqual({$min:{nextAt:at}})
 expect(((update.mock.calls as unknown[][])[0]![2] as any).timeoutMS).toBe(2000)
})


test('predecessor lookup includes missing historical repo only for MentraOS and never crosses a PR number into Mentra', async () => {
 const chain = {select: (_value: unknown) => chain, limit: (_value: unknown) => chain, read: (_value: unknown) => chain,
  readConcern: (_value: unknown) => chain, setOptions: (_value: unknown) => chain, lean: async () => [{gateId: 'previous'}]};
 const find = spyOn(PrRoutineCheckModel, 'find').mockReturnValue(chain as never); spies.push(find);
 expect(await prRoutineCheckRepository.predecessors(12, 'current', 'Mentra-Community/Mentra')).toEqual(['previous']);
 expect((find.mock.calls as unknown[][])[0]![0]).toEqual({'payload.context.number': 12, 'payload.context.repository': 'Mentra-Community/Mentra', gateId: {$ne: 'current'}});
 await prRoutineCheckRepository.predecessors(12, 'current');
 expect((find.mock.calls as unknown[][])[1]![0]).toEqual({'payload.context.number': 12, gateId: {$ne: 'current'},
  $or: [{'payload.context.repository': 'Mentra-Community/MentraOS'}, {'payload.context.repository': {$exists: false}}]});
});
