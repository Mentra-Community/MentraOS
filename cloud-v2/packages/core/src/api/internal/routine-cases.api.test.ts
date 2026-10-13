import {expect,test} from 'bun:test'
import {createInternalRoutineCaseApi} from './routine-cases.api'
const token='T'.repeat(40),caseId='mfc_'+'a'.repeat(64)
test('enrolled host auth supplies actor and cannot impersonate a different case owner in a body',async()=>{
 let actor:any,claimOwner:string|undefined
 const service={async update(_id:string,_input:unknown,value:any){actor=value;return{ok:true}},async claim(_id:string,_input:unknown,owner:string){claimOwner=owner;return{ok:true}}}
 const api=createInternalRoutineCaseApi(service as any,()=>JSON.stringify({mini:token}))
 const input={claim:{token:'C'.repeat(40),generation:1,branchKey:'b'.repeat(64),anchorRunId:'original'},mutation:{revision:0}}
 expect((await api.request('/'+caseId,{method:'PATCH',headers:{authorization:'Bearer '+'X'.repeat(40),'content-type':'application/json'},body:JSON.stringify(input)})).status).toBe(401)
 expect((await api.request('/'+caseId,{method:'PATCH',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)})).status).toBe(200)
 expect(actor.id).toBe('mini');expect(actor.generation).toBe(1)
 const claim={action:'acquire',mutationId:crypto.randomUUID(),revision:0,generation:1,branchKey:'b'.repeat(64),anchorRunId:'original',token:'C'.repeat(40),ttlSeconds:300}
 expect((await api.request('/'+caseId+'/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(claim)})).status).toBe(200)
 expect(claimOwner).toBe('mini')
})
