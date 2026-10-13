import {expect,test} from 'bun:test'
import {PrRoutineCaseService} from './pr-routine-case.service'
import {OriginalNotFailedError} from './routine-case-original.service'
import {TestRunError} from './test-result-error'
const pr={repository:'Mentra-Community/MentraOS' as const,number:12}
test('same original intended fixing PR and actor retain one stable operation through retries',async()=>{
 const calls:any[]=[]
 const service=new PrRoutineCaseService({async original(){return{rootKey:'same-original'}}} as any,{async create(...args:any[]){calls.push(args);return{case:{caseId:'same-case'}}}} as any,()=>true)
 expect(await service.attach('successor',pr,'employee')).toEqual({caseId:'same-case'})
 await service.attach('original',pr,'employee');expect(calls[0][1]).toBe(calls[1][1]);expect(calls[0][2]).toEqual({kind:'operator',id:'github:employee'})
 expect(calls[0][4]).toEqual(pr)
})
test('nonfailed original creates no failure case, but unavailable lineage is retried instead of silently ignored',async()=>{
 const service=(error:Error)=>new PrRoutineCaseService({async original(){throw error}} as any,{async create(){throw Error('must not create')}} as any,()=>true)
 expect(await service(new OriginalNotFailedError()).attach('passed',pr,'employee')).toEqual({})
 await expect(service(new TestRunError(409,'Original custody unsettled')).attach('unsettled',pr,'employee')).rejects.toThrow('unsettled')
 expect(await new PrRoutineCaseService(undefined,undefined,()=>false).attach('unused',pr,'employee')).toEqual({unavailable:true})
})
