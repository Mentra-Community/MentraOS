import {expect, test} from 'bun:test'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {renderToStaticMarkup} from 'react-dom/server'
import type {ResourceCheckReport} from '../../../../packages/core/src/types/resource-check-report.types'
import type {ResourceLifecycleSubject} from '../../../../packages/core/src/types/resource-lifecycle.types'
import {LaneResourceChecklist, LaneHealthSection} from './lane-health'
import {ResourceChecklist, resourceConditionSourceHref, resourceReportHref} from './resource-checklist'
import {ResourceHealthSection} from './resource-health'

const at = '2026-10-26T03:00:00Z', now = Date.parse(at), revision = 'a'.repeat(40)
function report(resourceId = 'phone:one'): ResourceCheckReport {
  return {resourceId, authorityHostId: 'host-one', contractVersion: 'phone-v1', operationId: 'original-check', checkedAt: at,
    resultSha256: 'b'.repeat(64), outcome: 'failed', evidenceRefs: ['original-reader'],
    conditions: (['passed', 'failed', 'unknown', 'not-checked'] as const).map((status, index) => ({id: `condition-${index}`,
      label: ['Phone connected', 'Battery charged', 'Network route known', 'Recorder checked'][index]!, status,
      reportedStatus: status === 'not-checked' ? null : status, observed: index === 1 ? 'Battery 2%' : null,
      expected: index === 1 ? 'Battery at least 20%' : null, explanation: index === 1 ? 'Battery is below the required level' : null,
      repairAction: index === 1 ? 'Charge the phone' : null, evidenceRefs: index === 1 ? ['original-battery-reader'] : [],
      source: index === 1 ? {path: 'testing/framework/platforms/phone-idle.ts', line: 27, revision} : null}))}
}
function resource(id = 'phone:one'): ResourceLifecycleSubject {
  return {subject: {kind: 'resource', id, authorityHostId: 'host-one'}, generation: 8, current: true, observedAt: at, receivedAt: at,
    status: 'in-repair', owner: null, reason: null, supportedActions: ['check'],
    idle: {contractVersion: 'phone-v1', outcome: 'failed', checkedAt: at, acceptedCheck: null,
      qualifiedScope: {kind: 'same-controller', controllerId: 'host-one'}, evidenceRefs: ['original-reader'], report: report(id)},
    repair: {configured: true, state: 'none'},
    resource: {kind: 'phone', placement: 'installed', capabilities: [], dependencies: [], memberships: [{hostId: 'host-one', laneId: 'android'}]}}
}

test('all checklist conditions preserve original outcomes, missing observations, timestamp and evidence', () => {
  const html = renderToStaticMarkup(<ResourceChecklist report={report()}/>)
  for (const label of ['Phone connected', 'Battery charged', 'Network route known', 'Recorder checked', 'Passed', 'Failed', 'Unknown', 'Not checked',
    'Battery 2%', 'Battery at least 20%', 'Charge the phone', 'original-battery-reader', 'original-reader', 'Not reported', 'original-check']) expect(html).toContain(label)
  expect(html).toContain(`dateTime="${at}"`)
  expect(html).toContain('bg-red-50 text-red-700')
  expect(html).toContain(`href="https://github.com/Mentra-Community/Mentra/blob/${revision}/testing/framework/platforms/phone-idle.ts#L27"`)
  expect(html).not.toContain('href="original-reader"')
})
test('changed contract displays every new condition as not checked without relabeling the original result', () => {
  const value = report()
  value.currentContract = {contractVersion: 'phone-v2', outcome: 'not-checked', conditions: [{...value.conditions[0]!,
    id: 'new-condition', label: 'New declared condition', status: 'not-checked', reportedStatus: null,
    observed: null, expected: null, explanation: null, source: null, evidenceRefs: [], repairAction: null}]}
  const html = renderToStaticMarkup(<ResourceChecklist report={value}/>)
  expect(html).toContain('Installed contract phone-v2 has not been checked')
  expect(html).toContain('New declared condition'); expect(html).toContain('Not checked')
  expect(html).toContain('original-check'); expect(html).toContain('phone-v1')
})

test('legacy absent reports and missing observation metadata remain explicit without invented links', () => {
  expect(renderToStaticMarkup(<ResourceChecklist/>)).toContain('Not reported')
  const value = report(); value.checkedAt = null; value.operationId = null; value.resultSha256 = null; value.contractVersion = null
  value.conditions[1]!.source = {path: 'testing/framework/platforms/phone-idle.ts', line: 27}
  const html = renderToStaticMarkup(<ResourceChecklist report={value}/>)
  expect(html).toContain('Checked: Not reported'); expect(html).toContain('revision not reported')
  expect(html).not.toContain('href='); expect(html).not.toContain('Invalid Date')
})

test('source references require a recorded commit and normalized repository path; observations render as text', () => {
  for (const path of ['../private', '/private/path', 'testing//file', 'javascript:alert(1)'])
    expect(resourceConditionSourceHref({path, line: 1, revision})).toBeNull()
  expect(resourceConditionSourceHref({path: 'testing/reader.ts', line: 0, revision})).toBeNull()
  expect(resourceConditionSourceHref({path: 'testing/reader.ts', line: 1, revision: 'dev'})).toBeNull()
  const value = report(); value.conditions[1]!.observed = '<img src=x onerror=alert(1)>'
  const html = renderToStaticMarkup(<ResourceChecklist report={value}/>)
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img src=x')
})

test('resource cards expose stable encoded report links and keep legacy management visible', () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}}), legacy = resource('legacy-resource')
  delete legacy.idle.report
  client.setQueryData(['resource-lifecycle'], {subjects: [resource(), legacy], history: []})
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ResourceHealthSection/></QueryClientProvider>)
  expect(html).toContain('id="resource-phone:one"')
  expect(html).toContain('href="/?systemHealth=1&amp;healthTab=resources#resource-phone%3Aone"')
  expect(html).toContain('Condition checklist'); expect(html).toContain('Battery charged')
  expect(html).toContain('Not reported'); expect(html).toContain('Manage resource')
  expect(resourceReportHref('phone:one')).toBe('/?systemHealth=1&healthTab=resources#resource-phone%3Aone')
  client.clear()
})

test('a direct report link finds its decoded card after data arrives and refreshes do not repeat scrolling', async () => {
  const {act, create} = await import('react-test-renderer'), originalWindow = globalThis.window, originalDocument = globalThis.document,
    client = new QueryClient({defaultOptions: {queries: {retry: false, enabled: false}}}), lookedUp: string[] = []
  let scrolls = 0, view!: import('react-test-renderer').ReactTestRenderer
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {location: {hash: '#resource-phone%3Aone'}}})
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {getElementById: (id: string) => {
    lookedUp.push(id); return {scrollIntoView: () => scrolls++}
  }}})
  try {
    await act(async () => {view = create(<QueryClientProvider client={client}><ResourceHealthSection/></QueryClientProvider>)})
    expect(scrolls).toBe(0)
    await act(async () => {client.setQueryData(['resource-lifecycle'], {subjects: [resource()], history: []}); await new Promise(resolve => setTimeout(resolve, 10))})
    expect(lookedUp).toEqual(['resource-phone:one']); expect(scrolls).toBe(1)
    await act(async () => {client.setQueryData(['resource-lifecycle'], {subjects: [resource('phone:one'), resource('second')], history: []}); await new Promise(resolve => setTimeout(resolve, 10))})
    expect(scrolls).toBe(1)
  } finally {
    await act(async () => view?.unmount()); client.clear()
    Object.defineProperty(globalThis, 'window', {configurable: true, value: originalWindow})
    Object.defineProperty(globalThis, 'document', {configurable: true, value: originalDocument})
  }
})

test('lane physical failures and recursive dependencies stay separate from ownership, restriction and stale telemetry', () => {
  const phone = resource(), dependency = resource('recorder'), unrelated = resource('unrelated')
  phone.resource.dependencies = ['recorder', 'missing-resource']; dependency.resource.memberships = []
  dependency.resource.dependencies = [phone.subject.id]; unrelated.resource.memberships = [{hostId: 'other-host', laneId: 'android'}]
  phone.owner = {id: 'actual-owner', kind: 'boundary-cleanup', generation: 9, hostId: 'host-one'}
  phone.reason = {code: 'resource-operator-out-of-service', message: 'Operator restriction remains'}
  dependency.observedAt = '2020-01-01T00:00:00Z'
  const html = renderToStaticMarkup(<LaneResourceChecklist hostId="host-one" laneId="android" resources={[phone, dependency, unrelated]} current now={now}/>)
  expect(html).toContain('Failed physical conditions'); expect(html).toContain('Battery charged: Battery is below the required level')
  expect(html).toContain('Resource owner: boundary-cleanup actual-owner'); expect(html).toContain('Operator restriction: Operator restriction remains')
  expect(html).toContain('Dependency'); expect(html).toContain('recorder'); expect(html).toContain('missing-resource')
  expect(html).toContain('Physical resource observation: Not reported'); expect(html).toContain('Controller telemetry is not current')
  expect(html).toContain('Last reported physical check'); expect(html).not.toContain('unrelated')
  expect((html.match(/#resource-phone%3Aone/g) ?? []).length).toBe(1)
})

test('lane report refresh failure retains historical check details with an explicit unknown current state', () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
  client.setQueryData(['lane-overview'], {hosts: [{hostId: 'host-one', observedAt: at, receivedAt: at,
    lanes: [{id: 'android', platform: 'android', state: 'idle', dispatchMode: 'automatic'}]}], freshForMs: 120_000})
  client.setQueryData(['resource-lifecycle'], {subjects: [resource()], history: []})
  client.getQueryCache().find({queryKey: ['resource-lifecycle']})!.setState({status: 'error', error: Error('Fixture refresh failure')})
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><LaneHealthSection/></QueryClientProvider>)
  expect(html).toContain('Physical resource reports could not refresh'); expect(html).toContain('Last reported physical check')
  expect(html).toContain('Battery charged'); expect(html).not.toContain('Current owner:')
  client.clear()
})

test('an unavailable inventory is distinct from a successful empty resource inventory', () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, retryOnMount: false}}})
  client.setQueryData(['lane-overview'], {hosts: [{hostId: 'host-one', observedAt: at, receivedAt: at,
    lanes: [{id: 'android', platform: 'android', state: 'idle', dispatchMode: 'automatic'}]}], freshForMs: 120_000})
  client.setQueryData(['resource-lifecycle'], {subjects: [], history: []})
  client.getQueryCache().find({queryKey: ['resource-lifecycle']})!.setState({data: undefined,
    status: 'error', error: Error('Inventory request failed')})
  const failed = renderToStaticMarkup(<QueryClientProvider client={client}><LaneHealthSection/></QueryClientProvider>)
  expect(failed).toContain('Physical resource inventory is unavailable')
  expect(failed).not.toContain('Required resource membership not reported')
  expect(failed).not.toContain('Displayed checklists retain their original observations')
  client.setQueryData(['resource-lifecycle'], {subjects: [], history: []})
  const empty = renderToStaticMarkup(<QueryClientProvider client={client}><LaneHealthSection/></QueryClientProvider>)
  expect(empty).toContain('Required resource membership not reported')
  expect(empty).not.toContain('Physical resource inventory is unavailable')
  client.clear()
})

test('a failed refresh of cached empty or unrelated inventory leaves current lane membership unknown', () => {
  for (const subjects of [[], [{...resource(), resource: {...resource().resource,
    memberships: [{hostId: 'other-host', laneId: 'android'}]}}]]) {
    const client = new QueryClient({defaultOptions: {queries: {retry: false, retryOnMount: false}}})
    client.setQueryData(['lane-overview'], {hosts: [{hostId: 'host-one', observedAt: at, receivedAt: at,
      lanes: [{id: 'android', platform: 'android', state: 'idle', dispatchMode: 'automatic'}]}], freshForMs: 120_000})
    client.setQueryData(['resource-lifecycle'], {subjects, history: []})
    client.getQueryCache().find({queryKey: ['resource-lifecycle']})!.setState({status: 'error', error: Error('Refresh failed')})
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><LaneHealthSection/></QueryClientProvider>)
    expect(html).toContain('Last reported inventory contained no matching resources for this lane')
    expect(html).toContain('Current membership and physical conditions are unknown')
    expect(html).not.toContain('Resource inventory is unavailable')
    expect(html).not.toContain('Required resource membership not reported')
    client.clear()
  }
})
