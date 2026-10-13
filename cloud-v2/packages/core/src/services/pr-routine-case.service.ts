import {createHash} from 'node:crypto'
import {RoutineCaseOriginalService,OriginalNotFailedError} from './routine-case-original.service'
import {RoutineCaseService} from './routine-case.service'
import type {CasePr} from '../types/routine-case.types'

export interface PrRoutineCaseAttacher {
 attach(originalRequestId:string,pr:CasePr,actor:string):Promise<{caseId?:string;unavailable?:boolean}>
}
/** A labelled verification names an intended fix; it never guesses the cause or starts a case executor. */
export class PrRoutineCaseService implements PrRoutineCaseAttacher {
 constructor(private readonly originals=new RoutineCaseOriginalService(),private readonly cases=new RoutineCaseService(undefined,undefined,originals),
  private readonly enabled=()=>process.env.ROUTINE_CASE_API_ENABLED==='true'){}
 async attach(originalRequestId:string,pr:CasePr,actor:string) {
  if(!this.enabled())return{unavailable:true}
  let occurrence
  try{occurrence=await this.originals.original(originalRequestId)}catch(error){
   if(error instanceof OriginalNotFailedError)return{} // A verification of a passed/cancelled original is not a failure case.
   throw error
  }
  const hash=createHash('sha256').update(JSON.stringify(['pr-intended-fix',occurrence.rootKey,pr,actor])).digest('hex')
  const mutationId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
  return{caseId:(await this.cases.create(occurrence,mutationId,{kind:'operator',id:`github:${actor}`},undefined,pr)).case.caseId}
 }
}
