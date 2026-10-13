import {expect,test} from 'bun:test'
import {Hono} from 'hono'
import {createRoutineCaseApi} from './routine-cases.api'
import type {AppEnv} from '../../types/hono.types'
const id='mfc_'+'a'.repeat(64)
test('Admin mutation actor is authenticated identity and attempts require the case occurrence, never an arbitrary outside run',async()=>{
 const calls:any[]=[],originals={async original(requestId:string){return{rootKey:requestId}}},service={assertAvailable(){},async create(...args:any[]){calls.push(args);return{case:{caseId:id}}},async detail(){return{case:{occurrences:[{occurrenceId:'owned',original:{requestId:'original'},rootKey:'root'}],intendedFixes:[],prObservations:[]}}}}
 const app=new Hono<AppEnv>();app.use('*',async(c,next)=>{c.set('developer',{developerId:'employee'} as any);await next()})
 app.route('/',createRoutineCaseApi(originals as any,service as any,{async history(...args:any[]){calls.push(args);return{attempts:[],nextBefore:null}}} as any))
 const post=(body:unknown)=>app.request('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 expect((await post({mutationId:crypto.randomUUID(),requestId:'original',owner:'impersonate'})).status).toBe(400)
 expect((await post({mutationId:crypto.randomUUID(),requestId:'original'})).status).toBe(201)
 expect(calls[0][2]).toEqual({kind:'operator',id:'employee'})
 expect((await app.request(`/${id}/occurrences/outside/attempts`)).status).toBe(404)
 expect((await app.request(`/${id}/occurrences/owned/attempts?before=3`)).status).toBe(200)
 expect(calls[1][0].occurrenceId).toBe('owned');expect(calls[1][1]).toBe(3)
})
test('suite followup rendering uses one bounded compact projection lookup for all members',async()=>{
 const calls:string[][]=[],app=createRoutineCaseApi({} as any,{assertAvailable(){}} as any,{} as any,{async summary(){return{suiteId:'suite',members:[{memberId:'one'},{memberId:'two'}]}}} as any,
  (async (roots:string[])=>{calls.push(roots);return new Map(roots.map(key=>[key,{caseId:'case'}]))}) as any)
 const response=await app.request('/suite/suite');expect(response.status).toBe(200);expect(calls).toHaveLength(1);expect(calls[0]).toHaveLength(2)
 expect(((await response.json()) as {members:unknown[]}).members).toHaveLength(2)
})
