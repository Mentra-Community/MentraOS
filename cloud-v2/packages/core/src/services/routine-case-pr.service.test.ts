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
