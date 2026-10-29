import {expect,test} from 'bun:test';
import {createTestRerunsApi,createTestRerunRoutes} from './test-reruns.api';
import type {TestRerunService} from '../../services/test-rerun.service';
test('internal mutations and history require the existing ingest capability',async()=>{
 const saved=process.env.TEST_RUN_INGEST_TOKEN;process.env.TEST_RUN_INGEST_TOKEN='x'.repeat(40);
 let calls=0;const service={async preview(body:any,actor:string){calls++;return {body,actor}},async history(){calls++;return {attempts:[]}}} as unknown as TestRerunService;
 const app=createTestRerunsApi(service);
 try {
 expect((await app.request('/preview',{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).status).toBe(401);
 expect((await app.request('/suite/root/members/item/history')).status).toBe(401);expect(calls).toBe(0);
 const response=await app.request('/preview',{method:'POST',body:'{}',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.TEST_RUN_INGEST_TOKEN}`}});
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect((await response.json() as {actor:string}).actor).toBe('internal:ingest');expect(calls).toBe(1);
 }finally{if(saved===undefined)delete process.env.TEST_RUN_INGEST_TOKEN;else process.env.TEST_RUN_INGEST_TOKEN=saved}
});

test('definitive build-selection rejection retains its status and message',async()=>{
 const {TestDispatchError}=await import('../../services/test-builds.service');
 for (const status of [404,409] as const){const app=createTestRerunRoutes({async preview(){throw new TestDispatchError(status,'Choose replacement artifact')}} as unknown as TestRerunService,'admin');
 const response=await app.request('/preview',{method:'POST',body:'{}',headers:{'content-type':'application/json'}});expect(response.status).toBe(status);expect((await response.json() as {message:string}).message).toBe('Choose replacement artifact');}
});
