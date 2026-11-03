import {expect,test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {ResourceHealthSection} from './resource-health';
const at=new Date().toISOString();
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
function render(stale=false,staleReceipt=false,current=true) {
 const query=new QueryClient({defaultOptions:{queries:{retry:false}}});
 query.setQueryData(['resource-lifecycle'],{subjects:[{subject:{id:'account-shared'},generation:4,status:'idle',current,observedAt:stale?'2020-01-01T00:00:00Z':at,receivedAt:staleReceipt?'2020-01-01T00:00:00Z':at,owner:null,reason:null,
  resource:{kind:'google-account',placement:'fleet',memberships:[]},idle:{outcome:'passed',contractVersion:'account-v1',qualifiedScope:{kind:'fleet'}},repair:{configured:true,state:'none'}}],history:[{id:'journal-4',resourceId:'account-shared',subjectGeneration:4,at,event:'released',ownerId:'run-previous',ownerGeneration:3,hostId:'borrower-host',laneId:'android'}]});
 const html=renderToStaticMarkup(<QueryClientProvider client={query}><ResourceHealthSection/></QueryClientProvider>);query.clear();return html;
}
test('fleet card exposes current shared identity and opens debug history separately',()=>{const html=render();expect(html).toContain('Fleet resource');expect(html).toContain('account-shared');expect(html).not.toContain('run-previous');expect(html).not.toContain('borrower-host/android');expect(html).toContain('Use history');expect(html).not.toContain('Installed:');expect(html).toContain('Idle')});
test('unchanged physical transition stays idle with a fresh authority receipt',()=>{const html=render(true);expect(html).not.toContain('Unknown');expect(html).toContain('>Idle<');expect(html).not.toContain('Last reported owner');expect(html).toContain('account-v1');expect(html).not.toContain('run-previous')});
test('stale authority receipt or unconfirmed current state stays unknown',()=>{
 for(const html of [render(true,true),render(false,false,false)]) {
  expect(html).toContain('Unknown');expect(html).not.toContain('>Idle<');expect(html).toContain('Last reported owner');expect(html).toContain('account-v1');expect(html).not.toContain('run-previous');
 }
});

test('opening use history makes only its own GET and a debug failure leaves current readiness visible',async()=>{
 const {act,create}=await import('react-test-renderer'),originalFetch=globalThis.fetch;
 try {
  for(const failed of [false,true]) {
   const requests:{path:string;method:string}[]=[],client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
   client.setQueryData(['resource-lifecycle'],{subjects:[{subject:{id:'shared-resource'},generation:4,status:'idle',current:true,observedAt:at,receivedAt:at,owner:null,reason:null,
    resource:{kind:'fixture',placement:'fleet',memberships:[]},idle:{outcome:'passed',contractVersion:'fixture-v1',qualifiedScope:{kind:'fleet'}},repair:{configured:true,state:'none'}}]});
   globalThis.fetch=(async(path,options)=>{requests.push({path:String(path),method:options?.method??'GET'});return failed?Response.json({message:'Debug unavailable'},{status:503}):Response.json({events:[{id:'old-return',at,event:'released',subjectGeneration:4,ownerId:'old-original'}],coverage:'retained debug window',nextCursor:null})}) as typeof fetch;
   let view!:import('react-test-renderer').ReactTestRenderer;
   try {
    await act(async()=>{view=create(<QueryClientProvider client={client}><ResourceHealthSection/></QueryClientProvider>)});
    expect(requests).toEqual([]);expect(JSON.stringify(view.toJSON())).toContain('Idle');expect(JSON.stringify(view.toJSON())).not.toContain('old-original');
    const disclosure=view.root.findAllByType('details').find(value=>value.findByType('summary').children.join('')==='Use history')!;
    await act(async()=>disclosure.props.onToggle({currentTarget:{open:true}}));
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))});
    expect(requests).toEqual([{path:'/api/admin/test-runs/resources/shared-resource/history',method:'GET'}]);
    const output=JSON.stringify(view.toJSON());expect(output).toContain('Idle');expect(output).not.toContain('Current resource status is unknown');
    expect(output).toContain(failed?'Use history is unavailable':'old-original');
   } finally {await act(async()=>view?.unmount());client.clear()}
  }
 } finally {globalThis.fetch=originalFetch}
});

test('history loads the exact next cursor and an evicted page can refresh its window without changing current status',async()=>{
 const {act,create}=await import('react-test-renderer'),originalFetch=globalThis.fetch,requests:string[]=[];
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
 client.setQueryData(['resource-lifecycle'],{subjects:[{subject:{id:'shared-resource'},generation:4,status:'idle',current:true,observedAt:at,receivedAt:at,owner:null,reason:null,
  resource:{kind:'fixture',placement:'fleet',memberships:[]},idle:{outcome:'passed',contractVersion:'fixture-v1',qualifiedScope:{kind:'fleet'}},repair:{configured:true,state:'none'}}]});
 let failed=true,shifted=false,view!:import('react-test-renderer').ReactTestRenderer;
 globalThis.fetch=(async(path)=>{
  requests.push(String(path));
  if(String(path).includes('?cursor='))return failed?Response.json({message:'History cursor left retained window'},{status:409}):Response.json({events:[{id:'event-101',at,event:'released',ownerId:'older-original'}],coverage:'retained debug window',nextCursor:null});
  return Response.json({events:[{id:shifted?'event-100':'event-50',at,event:'released',ownerId:shifted?'fresh-original':'first-original'}],coverage:'retained debug window',nextCursor:shifted?'event:100':'event:50'});
 }) as typeof fetch;
 try {
  await act(async()=>{view=create(<QueryClientProvider client={client}><ResourceHealthSection/></QueryClientProvider>)});
  const disclosure=view.root.findAllByType('details').find(value=>value.findByType('summary').children.join('')==='Use history')!;
  await act(async()=>disclosure.props.onToggle({currentTarget:{open:true}}));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))});
  expect(requests).toEqual(['/api/admin/test-runs/resources/shared-resource/history']);
  const more=()=>view.root.findAllByType('button').find(value=>value.children.join('')==='More history')!;
  expect(more()).toBeDefined();expect(JSON.stringify(view.toJSON())).toContain('first-original');
  await act(async()=>more().props.onClick());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))});
  expect(requests[1]).toBe('/api/admin/test-runs/resources/shared-resource/history?cursor=event%3A50');
  const unavailable=JSON.stringify(view.toJSON());expect(unavailable).toContain('More history is unavailable');expect(unavailable).toContain('first-original');expect(unavailable).toContain('Idle');
  failed=false;shifted=true;const refresh=view.root.findAllByType('button').find(value=>value.children.join('')==='Refresh history')!;
  await act(async()=>refresh.props.onClick());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))});
  expect(requests[2]).toBe('/api/admin/test-runs/resources/shared-resource/history');expect(JSON.stringify(view.toJSON())).toContain('fresh-original');
  await act(async()=>more().props.onClick());await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))});
  expect(requests[3]).toBe('/api/admin/test-runs/resources/shared-resource/history?cursor=event%3A100');
  const output=JSON.stringify(view.toJSON());expect(output).toContain('fresh-original');expect(output).toContain('older-original');expect(output).toContain('Idle');expect(output).not.toContain('More history is unavailable');expect(more()).toBeUndefined();
 } finally {await act(async()=>view?.unmount());client.clear();globalThis.fetch=originalFetch}
});
