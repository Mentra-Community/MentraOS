import {expect,test} from 'bun:test'
import {readCaseFollowUpSummaries} from './routine-case-projection.service'
test('list projections read each unique root in bounded Mongo batches without opening archives or GitHub',async()=>{
 const calls:string[][]=[],keys=Array.from({length:201},(_,i)=>`root${i}`)
 const rows={async byRoots(batch:string[]){calls.push(batch);return batch.map(key=>({caseId:'case'+key,classification:'undetermined',stage:'investigating',owner:null,updatedAt:'now',diagnosis:'',occurrences:[{rootKey:key},{rootKey:'unrequested'}],intendedFixes:[],prObservations:[]})) as any}}
 const result=await readCaseFollowUpSummaries([...keys,...keys],rows,true)
 expect(calls.map(batch=>batch.length)).toEqual([100,100,1]);expect(result.size).toBe(201);expect(result.has('unrequested')).toBe(false)
 expect((await readCaseFollowUpSummaries(keys,rows,false)).size).toBe(0);expect(calls).toHaveLength(3)
})
