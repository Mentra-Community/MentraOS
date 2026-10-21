import {expect, test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {ResourceControls, resourceControlState, resourceControlsAreFresh} from './resource-controls'
import type {ResourceControlsView, ResourceControlView} from '../../../../packages/core/src/types/lane-control.types'
import type {ResourceLifecycleSubject} from '../../../../packages/core/src/types/resource-lifecycle.types'

const at = new Date().toISOString()
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
const subject = {resourceId: 'shared-pair', subjectGeneration: 5}
const resource: ResourceLifecycleSubject = {subject: {id: 'shared-pair', kind: 'resource', authorityHostId: 'air3'}, generation: 5,
  current: true, observedAt: at, receivedAt: at, status: 'idle', reason: null, owner: null,
  idle: {contractVersion: 'pair-v1', outcome: 'passed', checkedAt: at, acceptedCheck: {operationId: 'accepted-check', subjectGeneration: 5,
    resultSha256: 'a'.repeat(64), acceptedAt: at}, qualifiedScope: {kind: 'controllers', controllerIds: ['android', 'mac']}, evidenceRefs: ['proof:check']},
  repair: {configured: true, state: 'none'}, supportedActions: ['reserve', 'release', 'check', 'mark-out-of-service'],
  resource: {kind: 'glasses', capabilities: ['connection'], placement: 'installed', memberships: [{hostId: 'air3', laneId: 'android'}, {hostId: 'air3', laneId: 'mac'}], dependencies: []}}
const control = (state: 'waiting' | 'granted' | 'returning' | 'released', operationId = state): ResourceControlView => ({operationId,
  hostId: 'air3', subject, action: state === 'released' || state === 'returning' ? 'release' : 'reserve', expiresAt: Date.now() + 120_000,
  receipt: {operationId, inputSha256: 'b'.repeat(64), hostId: 'air3', subject, completedAt: at, result: {status: 'accepted',
    reservation: {id: 'one-reservation', resourceId: 'shared-pair', generation: 8, state, purpose: 'Manual use', requestedAt: at}}}})
const data = (controls: ResourceControlView[] = []): ResourceControlsView => ({enabled: true, fresh: true, observedAt: at, subject, controls})
function render(value = data(), actual = resource) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
  client.setQueryData(['resource-controls', 'air3', 'shared-pair'], value)
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ResourceControls resource={actual} fresh={true}/></QueryClientProvider>)
  client.clear(); return html
}
test('resource controls require the exact currently observed generation and expiry', () => {
  const now = Date.parse(at)
  expect(resourceControlsAreFresh(data(), now, resource, now)).toBe(true)
  expect(resourceControlsAreFresh({...data(), subject: {...subject, subjectGeneration: 4}}, now, resource, now)).toBe(false)
  expect(resourceControlsAreFresh({...data(), subject: {...subject, resourceId: 'other'}}, now, resource, now)).toBe(false)
  expect(resourceControlsAreFresh({...data(), observedAt: '2020-01-01T00:00:00Z'}, now, resource, now)).toBe(false)
  expect(resourceControlsAreFresh(data(), now - 15_001, resource, now)).toBe(false)
  expect(resourceControlsAreFresh(data(), now, {...resource, current: false}, now)).toBe(false)
  expect(resourceControlsAreFresh(data(), now, {...resource, receivedAt: '2020-01-01T00:00:00Z'}, now)).toBe(false)
})
test('out-of-order delivery cannot revive a returned operator reservation', () => {
  expect(resourceControlState([control('released'), control('granted'), control('waiting')], 'shared-pair', 'air3').reservation).toBeUndefined()
  expect(resourceControlState([control('returning'), control('granted')], 'shared-pair', 'air3').reservation?.state).toBe('returning')
})
test('waiting zero generation and delayed grant remain one returned original while foreign nonzero generation stays blocked',()=>{
 const waiting=control('waiting'),grant=control('granted'),returned=control('released')
 if(waiting.receipt!.result.status==='accepted')waiting.receipt!.result.reservation!.generation=0
 if(returned.receipt!.result.status==='accepted')returned.receipt!.result.reservation!.generation=0
 for(const rows of [[waiting,grant,returned],[returned,grant,waiting]])expect(resourceControlState(rows,'shared-pair','air3').reservation).toBeUndefined()
 const foreign=control('released');if(foreign.receipt!.result.status==='accepted')foreign.receipt!.result.reservation!.generation=9
 const state=resourceControlState([grant,foreign],'shared-pair','air3');expect(state.pending).toBeDefined();expect(state.reservation?.state).toBe('granted')
 const other=control('released');if(other.receipt!.result.status==='accepted')other.receipt!.result.reservation!.purpose='Different original purpose'
 expect(resourceControlState([grant,other],'shared-pair','air3').reservation?.state).toBe('granted')
})
test('an accepted HTTP delivery record without a controller receipt remains pending', () => {
  const pending = {...control('waiting')}; delete pending.receipt
  expect(resourceControlState([pending], 'shared-pair', 'air3').pending?.operationId).toBe('waiting')
  const html = render(data([pending]))
  expect(html).toContain('Waiting for the controller')
  expect(html).not.toContain('Reserved for you')
})
test('foreign authority or mismatched receipt cannot grant or release a resource', () => {
  expect(resourceControlState([{...control('granted'), hostId: 'foreign'}], 'shared-pair', 'air3').reservation).toBeUndefined()
  for (const receipt of [
    {...control('granted').receipt!, hostId: 'foreign'},
    {...control('granted').receipt!, operationId: 'other-action'},
    {...control('granted').receipt!, subject: {...subject, subjectGeneration: 4}},
  ]) {
    const state = resourceControlState([{...control('granted'), receipt}], 'shared-pair', 'air3')
    expect(state.reservation).toBeUndefined(); expect(state.pending).toBeDefined()
  }
})
test('a shared resource uses one authority and shows normal operator return without a lane selection', () => {
  const html = render(data([control('returning')]))
  expect(html).toContain('Returning through cleanup')
  expect(html).toContain('Your reservation is being cleaned up')
  expect(html).not.toContain('Choose a lane')
})
test('stale or unsupported controls remain disabled instead of withdrawing live repair custody', () => {
  const html = render(data(), {...resource, supportedActions: []})
  expect((html.match(/disabled=""/g) ?? []).length).toBe(4)
  expect(html).toContain('This action is unavailable')
  const stale = render({...data(), fresh: false})
  expect(stale).toContain('The resource changed')
  expect((stale.match(/disabled=""/g) ?? []).length).toBe(4)
})

test('historical out-of-service acknowledgement does not override a fresh restored lifecycle status', () => {
  const previous: ResourceControlView = {...control('waiting'), action: 'mark-out-of-service', receipt: {
    operationId: 'waiting', inputSha256: 'b'.repeat(64), hostId: 'air3', subject, completedAt: at,
    result: {status: 'accepted', resource: {resourceId: 'shared-pair', generation: 5, status: 'out-of-service'}}}}
  const html = render(data([previous]), resource)
  expect(html).toContain('Your out-of-service action was accepted')
  expect(html).not.toContain('Resource is out of service.')
})

test('only a current manual restriction offers an explicit check and return to service', () => {
  const manual = render(data(), {...resource, status: 'out-of-service', reason: {code: 'resource-operator-out-of-service', message: 'Borrowed phone'}})
  expect(manual).toContain('Check and return to service')
  expect(manual).toContain('Refreshing this page does not remove it')
  const failed = render(data(), {...resource, status: 'out-of-service', reason: {code: 'repair-runtime-missing', message: 'Repair runtime absent'}})
  expect(failed).not.toContain('Check and return to service')
})

test('failed or silently discarded intent storage prevents any resource effect before a recoverable identity exists', async () => {
  const {act, create} = await import('react-test-renderer')
  const originalStorage = globalThis.sessionStorage, originalFetch = globalThis.fetch
  let posts = 0
  globalThis.fetch = (async (_path: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') posts++
    return Response.json(data())
  }) as typeof fetch
  try {
    for (const setItem of [() => {throw new Error('Quota exceeded')}, () => {}]) {
      Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {
        getItem: () => null, setItem, removeItem: () => {}}})
      const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
      client.setQueryData(['resource-controls', 'air3', 'shared-pair'], data())
      let view!: import('react-test-renderer').ReactTestRenderer
      try {
        await act(async () => {view = create(<QueryClientProvider client={client}><ResourceControls resource={resource} fresh/></QueryClientProvider>)})
        const button = (name: string) => view.root.findAllByType('button').find(value => value.children.join('') === name)!
        await act(async () => button('Check readiness').props.onClick())
        expect(posts).toBe(0)
        expect(JSON.stringify(view.toJSON())).toContain('Nothing was sent')
        await act(async () => view.unmount())
        await act(async () => {view = create(<QueryClientProvider client={client}><ResourceControls resource={resource} fresh/></QueryClientProvider>)})
        expect(posts).toBe(0)
      } finally {await act(async () => view?.unmount()); client.clear()}
    }
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: originalStorage})
  }
})

test('a lost reserve response survives remount and observes the exact original operation', async () => {
  const {act, create} = await import('react-test-renderer')
  const values = new Map<string, string>(), originalStorage = globalThis.sessionStorage, originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {
    getItem: (id: string) => values.get(id) ?? null, setItem: (id: string, value: string) => values.set(id, value), removeItem: (id: string) => values.delete(id)}})
  const posts: Array<Record<string, any>> = []; let fail = true
  globalThis.fetch = (async (_path: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') {
      const input = JSON.parse(String(options.body)); posts.push(input)
      if (fail) throw new Error('Delivery response unavailable')
      return Response.json({operationId: input.operationId, hostId: input.hostId, subject: input.subject, action: input.action, expiresAt: input.expiresAt})
    }
    return Response.json(data())
  }) as typeof fetch
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
  client.setQueryData(['resource-controls', 'air3', 'shared-pair'], data())
  let view!: import('react-test-renderer').ReactTestRenderer
  const mount = () => create(<QueryClientProvider client={client}><ResourceControls resource={resource} fresh/></QueryClientProvider>)
  const button = (name: string) => view.root.findAllByType('button').find(value => value.children.join('') === name)!
  try {
    await act(async () => {view = mount()})
    await act(async () => button('Reserve').props.onClick())
    await act(async () => view.root.findByProps({'aria-label': 'Resource reservation purpose'}).props.onChange({target: {value: '  Borrow glasses  '}}))
    await act(async () => {button('Confirm reserve').props.onClick(); await new Promise(resolve => setTimeout(resolve, 10))})
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({hostId: 'air3', subject, action: 'reserve', purpose: 'Borrow glasses'})
    expect(posts[0]).not.toHaveProperty('operatorId'); expect(values.size).toBe(1)
    await act(async () => view.unmount())
    await act(async () => {view = mount()})
    expect(button('Reserve').props.disabled).toBe(true)
    fail = false
    await act(async () => {button('Check previous action').props.onClick(); await new Promise(resolve => setTimeout(resolve, 10))})
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(values.size).toBe(0)
  } finally {
    await act(async () => view?.unmount()); client.clear(); globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: originalStorage})
  }
})

test('a resource change cannot silently retarget a reservation form to its new generation', async () => {
  const {act, create} = await import('react-test-renderer')
  const originalFetch = globalThis.fetch; let posts = 0
  let current = data()
  globalThis.fetch = (async (_path: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') posts++
    return Response.json(current)
  }) as typeof fetch
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
  client.setQueryData(['resource-controls', 'air3', 'shared-pair'], current)
  let view!: import('react-test-renderer').ReactTestRenderer
  const button = (name: string) => view.root.findAllByType('button').find(value => value.children.join('') === name)!
  try {
    await act(async () => {view = create(<QueryClientProvider client={client}><ResourceControls resource={resource} fresh/></QueryClientProvider>)})
    await act(async () => button('Reserve').props.onClick())
    await act(async () => view.root.findByProps({'aria-label': 'Resource reservation purpose'}).props.onChange({target: {value: 'Borrow'}}))
    current = {...current, subject: {...subject, subjectGeneration: 6}}
    await act(async () => {
      client.setQueryData(['resource-controls', 'air3', 'shared-pair'], current)
      view.update(<QueryClientProvider client={client}><ResourceControls resource={{...resource, generation: 6}} fresh/></QueryClientProvider>)
    })
    expect(button('Confirm reserve').props.disabled).toBe(true)
    await act(async () => button('Confirm reserve').props.onClick())
    expect(posts).toBe(0)
  } finally {await act(async () => view?.unmount()); client.clear(); globalThis.fetch = originalFetch}
})


test('a schema-legal immediately granted zero generation remains releasable and then terminal', () => {
  const granted = control('granted'), returning = control('returning'), released = control('released')
  for (const row of [granted, returning, released]) if (row.receipt!.result.status === 'accepted') row.receipt!.result.reservation!.generation = 0
  const active = resourceControlState([granted], 'shared-pair', 'air3')
  expect(active.pending).toBeUndefined(); expect(active.reservation?.generation).toBe(0)
  const cleanup = resourceControlState([granted, returning], 'shared-pair', 'air3')
  expect(cleanup.pending).toBeUndefined(); expect(cleanup.reservation?.state).toBe('returning')
  for (const rows of [[granted, returning, released], [released, returning, granted]]) {
    const state = resourceControlState(rows, 'shared-pair', 'air3')
    expect(state.pending).toBeUndefined(); expect(state.reservation).toBeUndefined()
  }
})


test('same-state zero grant replay preserves the known nonzero release generation', () => {
  const actual = control('granted'), delayed = {...control('granted')}
  if (delayed.receipt!.result.status === 'accepted') delayed.receipt!.result.reservation!.generation = 0
  for (const rows of [[actual, delayed], [delayed, actual]]) {
    const state = resourceControlState(rows, 'shared-pair', 'air3')
    expect(state.pending).toBeUndefined(); expect(state.reservation?.generation).toBe(8)
  }
})


test('zero returning receipt keeps the server constraint and refuses a conflicting later generation', () => {
  const returning = control('returning'), actual = control('granted')
  if (returning.receipt!.result.status === 'accepted') returning.receipt!.result.reservation!.generation = 0
  returning.reservationGenerationConstraint = 8
  const current = resourceControlState([returning], 'shared-pair', 'air3')
  expect(current.pending).toBeUndefined(); expect(current.reservation?.generation).toBe(0)
  if (actual.receipt!.result.status === 'accepted') actual.receipt!.result.reservation!.generation = 9
  expect(resourceControlState([returning, actual], 'shared-pair', 'air3').pending).toBeDefined()
  expect(resourceControlState([actual, returning], 'shared-pair', 'air3').pending).toBeDefined()
})
