import {expect, test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import type {FailureFollowUp} from '../../../../packages/core/src/types/routine-case.types'
import {CompactFollowUp, FollowUpAttempt, FollowUpSummary, RoutineFollowUp, parseCaseEvidence, parseFixingPr} from './routine-follow-up'

;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true
const base = '/api/admin/test-runs/follow-ups'
const now = '2026-10-13T01:00:00.000Z'
function row(): FailureFollowUp['case'] {
  return {version: 2, caseId: `mfc_${'a'.repeat(64)}`, revision: 2, generation: 0, classification: 'app', diagnosis: 'Wi-Fi used the wrong interface', evidence: [{kind: 'run', id: 'original-run'}, {kind: 'incident', id: 'rep_EVIDENCE'}], stage: 'fixing', nextAction: 'Verify the current PR build', owner: null, execution: null,
    intendedFixes: [{repository: 'Mentra-Community/MentraOS', number: 4722}], prObservations: [{repository: 'Mentra-Community/MentraOS', number: 4722, headSha: 'b'.repeat(40), state: 'merged', review: 'approved', mergedAt: now, observedAt: now}], createdAt: now, updatedAt: now,
    occurrences: ['android', 'ios-on-mac'].map((platform, index) => ({occurrenceId: `occurrence-${index}`, rootKey: String(index + 1).repeat(64), anchorRunId: `anchor-${index}`, verificationRequestIds: [], original: {requestId: `original-${index}`, memberId: `member-${index}`, routineId: `ota-${platform}`, platform, environment: index ? 'staging' : 'dev', channel: 'dev', repository: 'Mentra-Community/MentraOS', branch: 'dev', branchKey: 'b'.repeat(64)}}))}
}
const attempt = {attemptId: 'attempt-1', attemptNumber: 1, requestId: 'rerun-1', status: 'pass', publicationComplete: true, parent: {requestId: 'original-0'}, memberId: 'member-0', startedAt: now, finishedAt: '2026-10-13T02:01:00.000Z', delta: {requestId: 'rerun-1', changes: [], unknowns: ['Backend revision unverified'], noInputChanges: false}}
function client() {return new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}})}
function seed(cache: QueryClient, value = row()) {cache.setQueryData(['routine-follow-up', 'original-0'], {followUps: [value]})}

// A PR link is an association, never an executable or arbitrary source URL.
test('fix and evidence references accept permitted identities and reject arbitrary sources', () => {
  expect(parseFixingPr(' https://github.com/Mentra-Community/MentraOS/pull/4722/ ')).toEqual({repository: 'Mentra-Community/MentraOS', number: 4722})
  expect(parseCaseEvidence('incident', 'rep_EVIDENCE')).toEqual({kind: 'incident', id: 'rep_EVIDENCE'})
  expect(parseCaseEvidence('run', 'run-123')).toEqual({kind: 'run', id: 'run-123'})
  expect(() => parseFixingPr('https://github.com/Other/Repo/pull/1')).toThrow()
  expect(() => parseFixingPr('https://github.com/Mentra-Community/MentraOS/pull/0')).toThrow()
  expect(() => parseFixingPr('https://github.com/Mentra-Community/MentraOS/pull/9007199254740992')).toThrow()
  expect(() => parseCaseEvidence('run', 'https://example.com/run')).toThrow()
})
test('summary separates recorded stage, no owner and expired execution from verified PR inclusion', () => {
  const value = row(); value.execution = {owner: 'stopped-agent', generation: 1, state: 'expired'}
  const html = renderToStaticMarkup(<FollowUpSummary row={value}/>)
  expect(html).toContain('Fixing'); expect(html).toContain('Unassigned'); expect(html).toContain('Agent expired')
  expect(html).toContain('Inclusion in a tested build is unverified'); expect(html).toContain('Review approved')
  expect(html).toContain('href="/?report=rep_EVIDENCE"'); expect(html).toContain('href="/?testRun=original-run"')
  const complete = row(); complete.stage = 'verified'; complete.classification = 'undetermined'; complete.occurrences.forEach(value => {value.closure = {kind: 'closed', reason: 'Could not reproduce', at: now, actor: 'operator:person'}})
  expect(renderToStaticMarkup(<FollowUpSummary row={complete}/>)).toContain('>Closed</span>')
})
test('attempt pass needs completed publication and unknowns prevent an unqualified no-change claim', () => {
  const html = renderToStaticMarkup(<FollowUpAttempt attempt={{...attempt, inclusions: [{repository: 'Mentra-Community/MentraOS', number: 4722, component: 'app artifact', state: 'included', reason: 'Exact PR artifact; shared backend unverified'}]}}/>)
  expect(html).toContain('Passed'); expect(html).toContain('1h 01m 00s'); expect(html).toContain('No known input changes'); expect(html).not.toContain('>No input changes<')
  expect(html).toContain('app artifact included'); expect(html).toContain('shared backend unverified')
  expect(renderToStaticMarkup(<FollowUpAttempt attempt={{...attempt, publicationComplete: false}}/>)).not.toContain('>Passed<')
  expect(renderToStaticMarkup(<FollowUpAttempt attempt={{...attempt, publicationComplete: false, evidenceStatus: 'failed'}}/>)).toContain('evidence failed')
})
test('compact row remains one cause stage with intended PR status', () => {
  const html = renderToStaticMarkup(<CompactFollowUp row={{caseId: row().caseId, classification: 'app', stage: 'fixing', displayStage: 'fixing', owner: null, updatedAt: now, diagnosis: 'Diagnosis', intendedFixes: [{...row().intendedFixes[0]!, observation: row().prObservations[0]!}]}}/>)
  expect(html).toContain('Fixing · Unassigned'); expect(html).toContain('#4722'); expect(html).not.toContain('3 pass')
})

test('history includes every occurrence, pages are bounded and loaded only when opened', async () => {
  const {act, create} = await import('react-test-renderer')
  const originalFetch = globalThis.fetch, urls: string[] = [], cache = client(); seed(cache)
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input); urls.push(url)
    if (url.includes('/occurrences/')) return Response.json({attempts: [{...attempt, attemptNumber: url.includes('before=2') ? 1 : 2, attemptId: url.includes('before=2') ? 'old' : 'new'}], nextBefore: url.includes('before=2') ? null : 2})
    return Response.json({case: row(), activity: [{caseId: row().caseId, revision: url.includes('before=2') ? 1 : 2, mutationId: crypto.randomUUID(), digest: 'a'.repeat(64), actor: 'operator:person', at: now, kind: 'update', changed: ['diagnosis']}], nextBefore: url.includes('before=2') ? null : 2})
  }) as typeof fetch
  let view!: import('react-test-renderer').ReactTestRenderer
  try {
    await act(async () => {view = create(<QueryClientProvider client={cache}><RoutineFollowUp requestId="original-0" failed/></QueryClientProvider>); await new Promise(resolve => setTimeout(resolve, 10))})
    expect(urls).toHaveLength(0)
    // Native toggle target and currentTarget are the same element.
    const toggle = async (index: number) => {const node = {open: true}; await act(async () => {view.root.findAllByType('details')[index]!.props.onToggle({target: node, currentTarget: node}); await new Promise(resolve => setTimeout(resolve, 20))})}
    await toggle(0)
    expect(urls).toHaveLength(1); expect(urls[0]).toContain('?limit=20')
    expect(view.root.findAllByType('summary').map(value => value.children.map(child => typeof child === 'string' ? child : '').join('')).join('')).toContain('Activity and tested changes')
    await toggle(1)
    expect(urls.filter(url => url.includes('/occurrences/'))).toHaveLength(1)
    expect(urls.at(-1)).toContain('occurrence-0/attempts')
    const named = (name: string) => view.root.findAllByType('button').find(button => button.children.join('') === name)!
    await act(async () => {named('Older attempts').props.onClick(); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(urls.at(-1)).toContain('before=2')
    await act(async () => {named('Older activity').props.onClick(); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(urls.at(-1)).toContain('?limit=20&before=2')
    expect(view.root.findAllByType('summary').some(summary => summary.findAllByType('span').some(span => span.children.join('').includes('ota-ios-on-mac')))).toBe(true)
  } finally {await act(async () => view?.unmount()); cache.clear(); globalThis.fetch = originalFetch}
})

test('needs-input and occurrence closure use revisioned typed actions and preserve original identity', async () => {
  const {act, create} = await import('react-test-renderer')
  const originalFetch = globalThis.fetch, writes: {url: string; body: Record<string, unknown>}[] = [], cache = client(); seed(cache)
  globalThis.fetch = (async (input: unknown, options?: RequestInit) => {
    if (options?.method && options.method !== 'GET') writes.push({url: String(input), body: JSON.parse(String(options.body))})
    if (String(input).includes('/original/')) return Response.json({followUps: [row()]})
    if (String(input).includes('/attempts')) return Response.json({attempts: [], nextBefore: null})
    return Response.json({case: row(), activity: [], nextBefore: null})
  }) as typeof fetch
  let view!: import('react-test-renderer').ReactTestRenderer
  try {
    await act(async () => {view = create(<QueryClientProvider client={cache}><RoutineFollowUp requestId="original-0" failed/></QueryClientProvider>); await new Promise(resolve => setTimeout(resolve, 10))})
    const named = (name: string) => view.root.findAllByType('button').find(button => button.children.join('') === name)!
    await act(async () => named('Edit').props.onClick())
    await act(async () => view.root.findAllByType('select').find(select => select.props['aria-label'] === 'Follow-up stage')!.props.onChange({target: {value: 'needs-input'}}))
    const labelField = (text: string) => view.root.findAllByType('label').find(label => label.children[0] === text)!.findByType(text === 'Unanswered question' ? 'textarea' : 'input')
    await act(async () => {labelField('Recipient').props.onChange({target: {value: 'Philippe'}}); labelField('Unanswered question').props.onChange({target: {value: 'Please grant location permission'}})})
    await act(async () => {view.root.findByType('form').props.onSubmit({preventDefault() {}}); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(writes[0]!.body.revision).toBe(2); expect(writes[0]!.body.input).toEqual({recipient: 'Philippe', question: 'Please grant location permission'})
    expect(writes[0]!.body.evidence).toEqual(row().evidence)
    const toggle = async (index: number) => {const node = {open: true}; await act(async () => {view.root.findAllByType('details')[index]!.props.onToggle({target: node, currentTarget: node}); await new Promise(resolve => setTimeout(resolve, 20))})}
    await toggle(0); await toggle(1)
    await act(async () => named('Record verification or closure').props.onClick())
    const occurrenceForm = view.root.findAllByType('form').at(-1)!
    await act(async () => occurrenceForm.findByType('select').props.onChange({target: {value: 'verified'}}))
    await act(async () => {occurrenceForm.findByType('input').props.onChange({target: {value: 'verified-rerun'}}); occurrenceForm.findByType('textarea').props.onChange({target: {value: 'Exact app artifact passed'}})})
    await act(async () => {occurrenceForm.props.onSubmit({preventDefault() {}}); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(writes.at(-1)!.body.close).toEqual({occurrenceId: 'occurrence-0', kind: 'verified', requestId: 'verified-rerun', reason: 'Exact app artifact passed'})
    await act(async () => {occurrenceForm.findByType('select').props.onChange({target: {value: 'closed'}}); occurrenceForm.findByType('input').props.onChange({target: {value: ''}})})
    await act(async () => occurrenceForm.findByType('textarea').props.onChange({target: {value: 'Could not reproduce; cause remains undetermined'}}))
    await act(async () => {occurrenceForm.props.onSubmit({preventDefault() {}}); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(writes.at(-1)!.body.close).toEqual({occurrenceId: 'occurrence-0', kind: 'closed', reason: 'Could not reproduce; cause remains undetermined'})
  } finally {await act(async () => view?.unmount()); cache.clear(); globalThis.fetch = originalFetch}
})

test('lost mutation response retries exactly the saved revision and command', async () => {
  const {act, create} = await import('react-test-renderer')
  const originalFetch = globalThis.fetch, writes: unknown[] = [], cache = client(); seed(cache)
  let fail = true
  globalThis.fetch = (async (input: unknown, options?: RequestInit) => {
    if (options?.method === 'PATCH') {
      writes.push(JSON.parse(String(options.body)))
      if (fail) throw Error('Response lost')
      return Response.json({case: row(), activity: [], nextBefore: null})
    }
    return Response.json({followUps: [row()]})
  }) as typeof fetch
  let view!: import('react-test-renderer').ReactTestRenderer
  try {
    await act(async () => {view = create(<QueryClientProvider client={cache}><RoutineFollowUp requestId="original-0" failed/></QueryClientProvider>); await new Promise(resolve => setTimeout(resolve, 10))})
    const named = (name: string) => view.root.findAllByType('button').find(button => button.children.join('') === name)!
    await act(async () => named('Edit').props.onClick())
    await act(async () => {view.root.findByType('form').props.onSubmit({preventDefault() {}}); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(writes).toHaveLength(1); expect(named('Save follow-up').props.disabled).toBe(true)
    fail = false
    await act(async () => {named('Retry previous action').props.onClick(); await new Promise(resolve => setTimeout(resolve, 20))})
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0])
  } finally {await act(async () => view?.unmount()); cache.clear(); globalThis.fetch = originalFetch}
})

test('a normal passing original never queries the disabled case API or shows failure controls', async () => {
  const {act, create} = await import('react-test-renderer')
  const originalFetch = globalThis.fetch, cache = client(), urls:string[]=[]
  globalThis.fetch = (async (input: unknown) => {const url=String(input);urls.push(url);return url.endsWith('/lineage')
    ? Response.json({lineage:null,original:null}) : Response.json({message:'Routine case API disabled'},{status:503})}) as typeof fetch
  let view!: import('react-test-renderer').ReactTestRenderer
  try {
    await act(async () => {view = create(<QueryClientProvider client={cache}><RoutineFollowUp requestId="passed-original" failed={false}/></QueryClientProvider>); await new Promise(resolve => setTimeout(resolve, 20))})
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 20))})
    expect(view.toJSON()).toBeNull()
    expect(urls).toEqual(['/api/admin/test-runs/reruns/request/passed-original/lineage'])
  } finally {await act(async () => view?.unmount()); cache.clear(); globalThis.fetch = originalFetch}
})

test('a passing successor retains its failed original follow-up and explicitly reports case unavailability', async () => {
  const {act,create}=await import('react-test-renderer')
  const originalFetch=globalThis.fetch,cache=client(),urls:string[]=[]
  cache.setQueryData(['rerun-lineage','passed-successor'],{lineage:{parent:{requestId:'original-0'},memberId:'member-0'}})
  let disabled=false
  globalThis.fetch=(async(input:unknown)=>{const url=String(input);urls.push(url);return url.endsWith('/lineage')
    ? Response.json({lineage:{parent:{requestId:'original-0'},memberId:'member-0'}})
    : disabled?Response.json({message:'Routine case API disabled'},{status:503}):Response.json({followUps:[row()]})}) as typeof fetch
  let view!:import('react-test-renderer').ReactTestRenderer
  try {
    await act(async()=>{view=create(<QueryClientProvider client={cache}><RoutineFollowUp requestId="passed-successor" failed={false}/></QueryClientProvider>);await new Promise(resolve=>setTimeout(resolve,20))})
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})
    expect(view.root.findAllByProps({'aria-label':'Failure follow-up'})).toHaveLength(1)
    expect(JSON.stringify(view.toJSON())).toContain('Wi-Fi used the wrong interface')
    expect(urls).toContain(`${base}/original/passed-successor`)
    disabled=true
    await act(async()=>{await cache.invalidateQueries({queryKey:['routine-follow-up','passed-successor']});await new Promise(resolve=>setTimeout(resolve,20))})
    expect(JSON.stringify(view.toJSON())).toContain('Follow-up unavailable: ')
    expect(JSON.stringify(view.toJSON())).toContain('Routine case API disabled')
    expect(JSON.stringify(view.toJSON())).not.toContain('Unassigned')
  } finally {await act(async()=>view?.unmount());cache.clear();globalThis.fetch=originalFetch}
})
