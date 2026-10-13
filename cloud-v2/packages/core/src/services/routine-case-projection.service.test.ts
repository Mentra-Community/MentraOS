import {expect,test} from 'bun:test'
import {readCaseFollowUpSummaries} from './routine-case-projection.service'
test('list projections read each unique root in bounded Mongo batches without opening archives or GitHub',async()=>{
 const calls:string[][]=[],keys=Array.from({length:201},(_,i)=>`root${i}`)
 const rows={async byRoots(batch:string[]){calls.push(batch);return batch.map(key=>({caseId:'case'+key,classification:'undetermined',stage:'investigating',owner:null,updatedAt:'now',diagnosis:'',occurrences:[{rootKey:key},{rootKey:'unrequested'}],intendedFixes:[],prObservations:[]})) as any}}
 const result=await readCaseFollowUpSummaries([...keys,...keys],rows,true)
 expect(calls.map(batch=>batch.length)).toEqual([100,100,1]);expect(result.size).toBe(201);expect(result.has('unrequested')).toBe(false)
 expect((await readCaseFollowUpSummaries(keys,rows,false)).size).toBe(0);expect(calls).toHaveLength(3)
})
test('optional projection stops batches at the caller deadline and passes the remaining bound to Mongo',async()=>{
 const original=Date.now,calls:Array<{size:number;deadline?:number}>=[];let time=1000
 Date.now=()=>time
 try{
  const rows={async byRoots(batch:string[],deadline?:number){calls.push({size:batch.length,deadline});time=1501;return[]}}
  await readCaseFollowUpSummaries(Array.from({length:10000},(_,i)=>'root'+i),rows,true,1500)
  expect(calls).toEqual([{size:100,deadline:1500}])
  await readCaseFollowUpSummaries(['expired'],rows,true,1500);expect(calls).toHaveLength(1)
 }finally{Date.now=original}
})
