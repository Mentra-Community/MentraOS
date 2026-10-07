import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createTestRequestsApi} from './test-requests.api';
import {TestRequestService, TestRequestConflict, type StoredPreparingRequest} from '../../services/test-request.service';
import {GithubRoutineSourceGateway} from '../../services/routine-source-selection.service';
import {TestRunError} from '../../services/test-result-error';
import {RoutineDispatchService} from '../../services/routine-dispatch.service';
const token = 'synthetic-controller-credential-' + 'x'.repeat(32), headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
const bytes = new TextEncoder().encode('routine'), blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), commit = 'a'.repeat(40);
const row: StoredPreparingRequest = {requestId:'r1',hostId:'mini',state:'preparing',dispatchIntentSha256:'b'.repeat(64),dispatchIntent:{requestId:'r1',routineId:'sample',platform:'android',routineRevision:commit,laneId:'android',source:{channel:'dev',buildRunId:1,publicationAttempt:1},build:{repository:'Mentra-Community/MentraOS',headSha:'c'.repeat(40),channel:'dev',kind:'android-apk',source:{channel:'dev',buildRunId:1,publicationAttempt:1},archive:{name:'app.apk',url:'https://artifactscdn.mentraglass.com/app.apk',sha256:'d'.repeat(64),size:100},receipt:{url:'https://artifactscdn.mentraglass.com/receipt',sha256:'e'.repeat(64),size:10}}}};
function fixture() {
  let active=true, blobReads=0;
  class Service extends TestRequestService {
    override async preparation(id:string,host:string,digest?:string) {if(id!=='r1'||host!=='mini')throw new TestRunError(404,'not assigned');if(digest&&digest!==row.dispatchIntentSha256)throw new TestRequestConflict('changed');return {...row,state:active?'preparing' as const:'terminal' as const};}
    override async preparationStatus(id:string,host:string,input:unknown) {await this.preparation(id,host,(input as any).dispatchIntentSha256);return row;}
  }
  class Sources extends GithubRoutineSourceGateway {
    override async inventory(value:string) {expect(value).toBe(commit);return {commit,files:[{path:'routines/sample/routine.ts',gitBlobSha1:blob,size:bytes.length}]};}
    override async blob(value:{gitBlobSha1:string;size:number}) {blobReads++;expect(value.gitBlobSha1).toBe(blob);return bytes;}
  }
  const service=new Service(); const dispatch={async prepared(id:string,host:string,body:any){await service.preparation(id,host,body.dispatchIntentSha256);return row;}} as RoutineDispatchService;
  const api=createTestRequestsApi(service,()=>JSON.stringify({mini:token}),new Sources(),dispatch);
  return {api,get blobReads(){return blobReads},cancel(){active=false}};
}
test('exact source endpoints scope assigned request and inventory membership without exposing credentials',async()=>{
  const f=fixture();expect((await f.api.request('/r1/routine-source/inventory')).status).toBe(401);
  expect((await f.api.request('/r2/routine-source/inventory',{headers})).status).toBe(404);
  const inventory=await f.api.request('/r1/routine-source/inventory',{headers});expect(await inventory.json()).toEqual({commit,files:[{path:'routines/sample/routine.ts',gitBlobSha1:blob,size:bytes.length}]});
  expect((await f.api.request(`/r1/routine-source/blobs/${'f'.repeat(40)}`,{headers})).status).toBe(409);expect(f.blobReads).toBe(0);
  const downloaded=await f.api.request(`/r1/routine-source/blobs/${blob}`,{headers});expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);expect(downloaded.headers.get('content-length')).toBe(String(bytes.length));
  f.cancel();expect((await f.api.request(`/r1/routine-source/blobs/${blob}`,{headers})).status).toBe(409);expect(f.blobReads).toBe(1);
});
test('host sees actual preparation state and completion acknowledgment retains immutable intent',async()=>{
  const f=fixture(),detail=await f.api.request('/r1/preparation',{headers});expect(await detail.json()).toEqual({request:row});
  const body={dispatchIntentSha256:row.dispatchIntentSha256};
  expect((await f.api.request('/r1/prepared',{method:'POST',headers,body:JSON.stringify({...body,dispatchIntentSha256:'changed'})})).status).toBe(409);
  expect(await (await f.api.request('/r1/prepared',{method:'POST',headers,body:JSON.stringify(body)})).json()).toEqual({request:row});
});


test('invalid exact source is distinguished from cancelled preparation and transient acquisition', async () => {
  class Sources extends GithubRoutineSourceGateway {override async inventory(): Promise<never> {throw new TestRunError(422, 'Selected source contains a symbolic link.')}}
  class Service extends TestRequestService {override async preparation() {return row}}
  const api=createTestRequestsApi(new Service(),()=>JSON.stringify({mini:token}),new Sources());
  const response=await api.request('/r1/routine-source/inventory',{headers});
  expect(response.status).toBe(422);expect(await response.json()).toEqual({error:'routine_source_invalid',message:'Selected source contains a symbolic link.'});
});
