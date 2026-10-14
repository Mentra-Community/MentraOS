import {expect, test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {LaneControls, laneControlState, laneControlsAreFresh} from './lane-controls'
import type {LaneControlView, LaneControlsView} from '../../../../packages/core/src/types/lane-control.types'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const now = Date.now(), operationId = '11111111-1111-4111-8111-111111111111'
function row(state: 'waiting'|'granted'|'returning'|'released'|'cancelled', action: 'reserve'|'release' = 'reserve'): LaneControlView {
 return {operationId,hostId:'air',laneId:'phone',action,expiresAt:now+120000,receipt:{operationId,hostId:'air',laneId:'phone',inputSha256:'a'.repeat(64),completedAt:new Date(now).toISOString(),
  result:{status:'accepted',reservation:{id:'held',laneId:'phone',generation:state==='waiting'?0:1,state,purpose:'Manual work',requestedAt:new Date(now).toISOString()}}}}
}
test('released receipt wins over retained grant and waiting cancel stays an available own reservation',()=>{
 expect(laneControlState([row('granted'),row('released','release')],'phone').reservation).toBeUndefined()
 expect(laneControlState([row('released','release'),row('granted')],'phone').reservation).toBeUndefined()
 expect(laneControlState([row('waiting')],'phone').reservation?.state).toBe('waiting')
 expect(laneControlState([row('waiting')],'other').reservation).toBeUndefined()
})
test('control freshness requires its own recent query and current supported controller report',()=>{
 const data: LaneControlsView = {enabled:true,fresh:true,observedAt:new Date(now).toISOString(),controls:[]}
 expect(laneControlsAreFresh(data,now,now)).toBe(true)
 expect(laneControlsAreFresh(data,now-15001,now)).toBe(false)
 expect(laneControlsAreFresh({...data,observedAt:new Date(now-120001).toISOString()},now,now)).toBe(false)
 expect(laneControlsAreFresh({...data,enabled:false},now,now)).toBe(false)
})
function render(controls: LaneControlView[], fresh=true, mode='automatic') {
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
 client.setQueryData(['lane-controls','air'],{enabled:true,fresh:true,observedAt:new Date().toISOString(),controls})
 return renderToStaticMarkup(<QueryClientProvider client={client}><LaneControls hostId="air" laneId="phone" mode={mode} fresh={fresh}/></QueryClientProvider>)
}
test('four compact controls explain scheduling and cleanup, including keyboard help on disabled actions',()=>{
 const html=render([row('waiting')]); expect(html).toContain('Resume scheduling');expect(html).toContain('Your reservation: Waiting')
 expect(html).toContain('role="tooltip"');expect(html).toContain('tabindex="0"');expect(html).toContain('A running job continues')
 expect(html).toContain('Your reservation and any repair remain unchanged')
 const release=html.match(/<button[^>]*>Release<\/button>/)?.[0];expect(release).toBeDefined();expect(release).not.toMatch(/ disabled[=> ]/)
 expect(html).not.toContain('Out of service');expect(html).not.toContain('Trigger repair')
 expect(render([],false)).toContain('Refresh the lane status before making changes')
 expect(render([row('returning')])).toContain('Cleanup in progress')
 expect(render([row('released')])).toContain('You do not hold a reservation on this lane')
})

test('lost mutation response retries the exact saved command and browser refresh retains operator reservation',async()=>{
 const {act,create} = await import('react-test-renderer')
 const values = new Map<string,string>(), originalStorage=globalThis.sessionStorage, originalFetch=globalThis.fetch
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(id:string)=>values.get(id)??null,setItem:(id:string,value:string)=>values.set(id,value),removeItem:(id:string)=>values.delete(id)}})
 const requests:unknown[]=[];let fail=true
 globalThis.fetch=(async(_input:unknown,options?:RequestInit)=>{
  if(options?.method==='POST'){requests.push(JSON.parse(String(options.body)));if(fail)throw new Error('Network unavailable')
   return Response.json({...requests[requests.length-1] as object,expiresAt:now+120000})}
  return Response.json({enabled:true,fresh:true,observedAt:new Date().toISOString(),controls:[]})
 }) as typeof fetch
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
 client.setQueryData(['lane-controls','air'],{enabled:true,fresh:true,observedAt:new Date().toISOString(),controls:[]})
 let view!:import('react-test-renderer').ReactTestRenderer
 try {
  await act(async()=>{view=create(<QueryClientProvider client={client}><LaneControls hostId="air" laneId="phone" mode="automatic" fresh/></QueryClientProvider>)})
  const named=(name:string)=>view.root.findAllByType('button').find(button=>button.children.join('')===name)!
  await act(async()=>{named('Pause').props.onClick();await new Promise(resolve=>setTimeout(resolve,10))})
  expect(requests).toHaveLength(1);const saved=values.get('lane-control:air:phone');expect(saved).toBeDefined()
  await act(async()=>view.unmount())
  await act(async()=>{view=create(<QueryClientProvider client={client}><LaneControls hostId="air" laneId="phone" mode="automatic" fresh/></QueryClientProvider>)})
  fail=false
  await act(async()=>{named('Check previous action').props.onClick();await new Promise(resolve=>setTimeout(resolve,10))})
  expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);expect(values.has('lane-control:air:phone')).toBe(false)
 }finally{await act(async()=>view?.unmount());client.clear();globalThis.fetch=originalFetch;Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:originalStorage})}
})

const haltedLane = {id: 'phone', state: 'out-of-service', activity: {generation: 99,
  owner: {kind: 'fixer' as const, id: 'fixer:original'}}, repair: {executionId: 'fixer:original',
  interruptionId: 'repair:phone:98', laneId: 'phone', state: 'halted' as const, current: false,
  startedAt: new Date(now - 1000).toISOString(), finishedAt: new Date(now).toISOString(), haltDecisionId: 'halt:original'}}
function renderRepair(lane = haltedLane, mode = 'automatic', fresh = true, supported = true, controls: LaneControlView[] = []) {
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
 client.setQueryData(['lane-controls','air'],{enabled:true,reopenRepair:supported,fresh:true,observedAt:new Date().toISOString(),controls})
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><LaneControls hostId="air" laneId="phone" mode={mode} fresh={fresh} lane={lane}/></QueryClientProvider>)
 client.clear(); return html
}
test('halted repair offers recovery, blocks Pause and Reserve, and keeps scheduling and own Release separate', () => {
 const html = renderRepair(haltedLane, 'paused', true, true, [row('waiting')])
 for(const name of ['Pause','Reserve']) expect(html.match(new RegExp(`<button[^>]*>${name}</button>`))?.[0]).toMatch(/ disabled[=> ]/)
 expect(html.match(/<button[^>]*>Resume scheduling<\/button>/)?.[0]).not.toMatch(/ disabled[=> ]/)
 expect(html.match(/<button[^>]*>Release<\/button>/)?.[0]).not.toMatch(/ disabled[=> ]/)
 expect(html.match(/<button[^>]*>Retry recovery<\/button>/)?.[0]).not.toMatch(/ disabled[=> ]/)
 expect(html).toContain('may stay out of service if it is not ready')
 expect(renderRepair(haltedLane, 'automatic', false).match(/<button[^>]*>Retry recovery<\/button>/)?.[0]).toMatch(/ disabled[=> ]/)
 expect(renderRepair(haltedLane, 'automatic', true, false)).toContain('has not enabled recovery retries')
})
test('recovery is absent for a working, foreign or unidentified repair', () => {
 for(const lane of [
  {...haltedLane,state:'in-repair'},
  {...haltedLane,repair:{...haltedLane.repair,current:true}},
  {...haltedLane,repair:{...haltedLane.repair,executionId:'fixer:foreign'}},
  {...haltedLane,repair:{...haltedLane.repair,haltDecisionId:undefined}},
 ]) expect(renderRepair(lane as typeof haltedLane)).not.toContain('>Retry recovery</button>')
})
test('recovery click posts exactly the current halt and human change through the existing authenticated controls route', async () => {
 const {act,create} = await import('react-test-renderer')
 const originalFetch = globalThis.fetch; const posts: Array<{path:string;body:any}> = []
 globalThis.fetch = (async(input:unknown,options?:RequestInit) => {
  if(options?.method === 'POST') {posts.push({path:String(input),body:JSON.parse(String(options.body))}); return Response.json({operationId:posts.at(-1)!.body.operationId})}
  return Response.json({enabled:true,reopenRepair:true,fresh:true,observedAt:new Date().toISOString(),controls:[]})
 }) as typeof fetch
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
 client.setQueryData(['lane-controls','air'],{enabled:true,reopenRepair:true,fresh:true,observedAt:new Date().toISOString(),controls:[]})
 let view!:import('react-test-renderer').ReactTestRenderer
 try {
  await act(async()=>{view=create(<QueryClientProvider client={client}><LaneControls hostId="air" laneId="phone" mode="automatic" fresh lane={haltedLane}/></QueryClientProvider>)})
  const button=(name:string)=>view.root.findAllByType('button').find(value=>value.children.join('')===name)!
  await act(async()=>button('Retry recovery').props.onClick())
  expect(button('Confirm recovery retry').props.disabled).toBe(true)
  await act(async()=>view.root.findByProps({'aria-label':'What changed for recovery'}).props.onChange({target:{value:'  I allowed microphone access.  '}}))
  await act(async()=>{button('Confirm recovery retry').props.onClick();await new Promise(resolve=>setTimeout(resolve,10))})
  expect(posts).toHaveLength(1)
  expect(posts[0]!.path).toBe('/api/admin/test-runs/lanes/controls')
  expect(posts[0]!.body).toMatchObject({hostId:'air',laneId:'phone',action:'reopen-repair',repair:{interruptionId:'repair:phone:98',expectedHaltDecisionId:'halt:original',changedConditions:'I allowed microphone access.'}})
  expect(posts[0]!.body.operationId).toMatch(/^[a-f0-9-]{36}$/)
  expect(posts[0]!.body).not.toHaveProperty('mode');expect(posts[0]!.body).not.toHaveProperty('ready')
 } finally {await act(async()=>view?.unmount());client.clear();globalThis.fetch=originalFetch}
})

test('a repair changed after entering the recovery form cannot silently retarget the human action', async () => {
 const {act,create} = await import('react-test-renderer')
 const originalFetch = globalThis.fetch; let posts = 0
 globalThis.fetch = (async(_input:unknown,options?:RequestInit) => {
  if(options?.method === 'POST') posts++
  return Response.json({enabled:true,reopenRepair:true,fresh:true,observedAt:new Date().toISOString(),controls:[]})
 }) as typeof fetch
 const client = new QueryClient({defaultOptions:{queries:{retry:false}}})
 client.setQueryData(['lane-controls','air'],{enabled:true,reopenRepair:true,fresh:true,observedAt:new Date().toISOString(),controls:[]})
 const component=(lane:typeof haltedLane)=><QueryClientProvider client={client}><LaneControls hostId="air" laneId="phone" mode="automatic" fresh lane={lane}/></QueryClientProvider>
 let view!:import('react-test-renderer').ReactTestRenderer
 try {
  await act(async()=>{view=create(component(haltedLane))})
  const button=(name:string)=>view.root.findAllByType('button').find(value=>value.children.join('')===name)!
  await act(async()=>button('Retry recovery').props.onClick())
  await act(async()=>view.root.findByProps({'aria-label':'What changed for recovery'}).props.onChange({target:{value:'I allowed microphone access.'}}))
  await act(async()=>view.update(component({...haltedLane,repair:{...haltedLane.repair,haltDecisionId:'halt:replacement'}})))
  expect(button('Confirm recovery retry').props.disabled).toBe(true)
  await act(async()=>button('Confirm recovery retry').props.onClick())
  expect(posts).toBe(0)
  expect(JSON.stringify(view.toJSON())).toContain('The repair changed.')
 } finally {await act(async()=>view?.unmount());client.clear();globalThis.fetch=originalFetch}
})
