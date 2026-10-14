import {expect,test} from 'bun:test'
import {RoutineCasePrReader} from './routine-case-pr.service'
const pr={repository:'Mentra-Community/MentraOS' as const,number:4710},head='a'.repeat(40)
test('fix PR observations use exact current head reviews and preserve unavailable rather than claiming merge',async()=>{
 const urls:string[]=[],fetcher=async(url:string)=>{urls.push(url);return Response.json(url.includes('/reviews')?[{user:{login:'reviewer'},state:'APPROVED',commit_id:'b'.repeat(40),submitted_at:'2026-10-12T00:00:00Z'}]:{number:4710,state:'open',merged_at:null,head:{sha:head}})}
 const reader=new RoutineCasePrReader({async token(){return'token'}} as any,fetcher as typeof fetch,()=>Date.parse('2026-10-12T00:00:00Z'))
 expect((await reader.observe(pr)).review).toBe('pending');expect(urls).toHaveLength(2)
 const broken=new RoutineCasePrReader({async token(){return'token'}} as any,(async()=>new Response('Unavailable',{status:503})) as unknown as typeof fetch)
 await expect(broken.observe(pr)).rejects.toThrow('unavailable')
})

import type {RoutineFixInput} from '../types/routine-fix-provenance.types'
const tested:RoutineFixInput={requestId:'verified',observed:true,app:{repository:pr.repository,headSha:'c'.repeat(40),artifactSha256:'d'.repeat(64)},
 routine:{revision:'e'.repeat(40),bundleSha256:'f'.repeat(64)},framework:{revision:'1'.repeat(40),version:10,runtimeSha256:'2'.repeat(64),apiVersion:37},glasses:null,execution:{hostId:'air',laneId:'mac'},backend:null}
const at=Date.parse('2026-10-13T00:00:00Z'),merge='3'.repeat(40)
test('merged ancestry is checked against exact published components and reused only for the same PR source',async()=>{
 const urls:string[]=[],fetcher=async(url:string)=>{urls.push(url);return Response.json(url.includes('/reviews')?[]:url.includes('/compare/')?{status:'ahead',base_commit:{sha:merge}}:{number:pr.number,state:'closed',merged_at:new Date(at).toISOString(),merge_commit_sha:merge,head:{sha:head}})}
 const reader=new RoutineCasePrReader({async token(){return'token'}} as any,fetcher as typeof fetch,()=>at)
 const observation=await reader.observe(pr,{inputs:[tested,tested],deadline:at+20000})
 expect(observation.mergeCommitSha).toBe(merge);expect(observation.inclusions).toEqual([{component:'app artifact',revision:tested.app.headSha,sourceSha:merge,state:'included',observedAt:new Date(at).toISOString()}])
 expect(urls.filter(url=>url.includes('/compare/'))).toEqual([`https://api.github.com/repos/${pr.repository}/compare/${merge}...${tested.app.headSha}?per_page=1`])
 urls.length=0;await reader.observe(pr,{inputs:[tested],deadline:at+20000,previous:observation});expect(urls.some(url=>url.includes('/compare/'))).toBe(false)
 urls.length=0;await reader.observe(pr,{inputs:[tested],deadline:at+20000,previous:{...observation,headSha:'9'.repeat(40)}});expect(urls.some(url=>url.includes('/compare/'))).toBe(true)
})
test('framework and routine comparisons stay in their repository; unavailable comparisons remain unknown',async()=>{
 const harness={repository:'Mentra-Community/Mentra-Automated-Testing' as const,number:10},urls:string[]=[]
 const fetcher=async(url:string)=>{urls.push(url);return url.includes('/reviews')?Response.json([]):url.includes('/compare/')?new Response('Forbidden',{status:403}):Response.json({number:10,state:'open',merged_at:null,head:{sha:head}})}
 const reader=new RoutineCasePrReader({async token(){return'token'}} as any,fetcher as typeof fetch,()=>at)
 const observation=await reader.observe(harness,{inputs:[tested,{...tested,observed:false}],deadline:at+20000})
 expect(observation.inclusions?.map(value=>[value.component,value.revision,value.state])).toEqual([['routine bundle',tested.routine.revision,'unverified'],['framework',tested.framework!.revision,'unverified']])
 expect(urls.filter(url=>url.includes('/compare/')).every(url=>url.includes(`repos/${harness.repository}/compare/`))).toBe(true)
 expect(urls.some(url=>url.includes(tested.app.headSha))).toBe(false)
})
test('explicit refresh comparison inventory is deduplicated and capped',async()=>{
 let comparisons=0
 const reader=new RoutineCasePrReader({async token(){return'token'}} as any,(async(url:string)=>{if(url.includes('/compare/')){comparisons++;return Response.json({status:'behind',base_commit:{sha:head}})}return Response.json(url.includes('/reviews')?[]:{number:pr.number,state:'open',merged_at:null,head:{sha:head}})})as typeof fetch,()=>at)
 const inputs=Array.from({length:30},(_,i)=>({...tested,app:{...tested.app,headSha:(i+10).toString(16).padStart(40,'0')}}))
 const observation=await reader.observe(pr,{inputs,deadline:at+20000})
 expect(comparisons).toBe(10);expect(observation.inclusions).toHaveLength(10);expect(observation.inclusions?.every(value=>value.state==='not-included')).toBe(true)
})

test('bounded framework comparisons prioritize newest recorded input before older component pairs',async()=>{
 const harness={repository:'Mentra-Community/Mentra-Automated-Testing' as const,number:10},revisions:string[]=[]
 const reader=new RoutineCasePrReader({async token(){return'token'}}as any,(async(url:string)=>{
  if(url.includes('/compare/')){revisions.push(url.split('...')[1].split('?')[0]);return Response.json({status:'ahead',base_commit:{sha:head}})}
  return Response.json(url.includes('/reviews')?[]:{number:10,state:'open',merged_at:null,head:{sha:head}})
 })as typeof fetch,()=>at)
 const newestFirst=Array.from({length:10},(_,i)=>({...tested,routine:{...tested.routine,revision:(20-i).toString(16).padStart(40,'0')},
  framework:{...tested.framework!,revision:(40-i).toString(16).padStart(40,'0')}}))
 const observation=await reader.observe(harness,{inputs:newestFirst,deadline:at+20000})
 expect(revisions).toHaveLength(10)
 expect(revisions.slice(0,2)).toEqual([newestFirst[0].routine.revision,newestFirst[0].framework.revision])
 expect(observation.inclusions?.slice(0,2).map(value=>value.state)).toEqual(['included','included'])
})
