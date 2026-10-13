import {expect, test} from 'bun:test'
import {GithubPrRoutineChecks} from './pr-routine-check-github'
import {TestRunGithubApp} from './test-run-github-app'
import {ROUTINE_CHECK_NAME, ROUTINE_CHECK_REPOSITORY, type CheckPayload, type PrRoutineContext} from '../types/pr-routine-check.types'

const head = 'a'.repeat(40), otherHead = 'b'.repeat(40), appId = 17
const payload: CheckPayload = {name: ROUTINE_CHECK_NAME, head_sha: head, external_id: 'gate-one:2',
  status: 'in_progress', started_at: '2026-10-12T00:00:00Z', details_url: 'https://admin.dev.mentraglass.com/?testRuns=1',
  output: {title: 'Routine tests', summary: 'Waiting for routine results'}, actions: []}
const check = (id = 99, external_id = 'gate-one:1', applicationId = appId, head_sha = head) =>
  ({id, external_id, name: ROUTINE_CHECK_NAME, head_sha, app: {id: applicationId}, status: 'in_progress', conclusion: null, completed_at: null})
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status})
type Call = {path: string; method: string; init: RequestInit; body?: Record<string, unknown>}
function fixture(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [], scopes: string[] = []
  class App extends TestRunGithubApp {
    override async token(scope: Parameters<TestRunGithubApp['token']>[0]) {scopes.push(scope); return `test-${scope}`}
  }
  const app = new App({credentials: {appId: String(appId)}})
  const transport = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const prefix = `https://api.github.com/repos/${ROUTINE_CHECK_REPOSITORY}/`
    expect(String(url).startsWith(prefix)).toBe(true)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer test-${scopes.at(-1)}`)
    const call: Call = {path: String(url).slice(prefix.length), method: init.method ?? 'GET', init,
      ...(init.body ? {body: JSON.parse(String(init.body))} : {})}
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return {github: new GithubPrRoutineChecks(app, transport), calls, scopes}
}
const inventory = (rows: ReturnType<typeof check>[], total = rows.length) => reply({total_count: total, check_runs: rows})

test('lost create acknowledgement reconciles the same owned gate by read and patch without another create', async () => {
  let created: ReturnType<typeof check> | undefined
  const f = fixture(call => {
    if (call.path.startsWith('commits/')) return inventory(created ? [created] : [])
    if (call.method === 'POST') {created = check(99, payload.external_id); throw new Error('response lost after GitHub committed the create')}
    if (call.method === 'PATCH') {expect(call.body).not.toHaveProperty('head_sha'); return reply({...created!, ...call.body})}
    return reply(created)
  })
  await expect(f.github.deliver(undefined, payload, true)).rejects.toThrow('retained operation will reconcile')
  expect(await f.github.deliver(undefined, payload, false)).toBe(99)
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET', 'GET', 'GET', 'PATCH'])
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(f.calls.at(-1)!.body).toMatchObject({external_id: payload.external_id, output: payload.output})
  expect(f.scopes.every(scope => scope === 'checks')).toBe(true)
})

test('uncertain creation with no visible receipt cannot repeat POST', async () => {
  const f = fixture(() => inventory([]))
  await expect(f.github.deliver(undefined, payload, false)).rejects.toThrow('without repeating the create')
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

test('duplicate own-gate receipts and incomplete history block writes', async () => {
  for (const response of [() => inventory([check(1, payload.external_id), check(2, payload.external_id)]), () => inventory([check(1)], 2)]) {
    const f = fixture(response)
    await expect(f.github.deliver(undefined, payload, true)).rejects.toThrow()
    expect(f.calls.map(call => call.method)).toEqual(['GET'])
  }
})

test('checks from other Apps are ignored without adopting their IDs', async () => {
  const f = fixture(call => call.method === 'POST' ? reply(check(99, payload.external_id), 201) : inventory([check(1, payload.external_id, 18)]))
  expect(await f.github.deliver(undefined, payload, true)).toBe(99)
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST'])
  expect(f.calls[1]!.body).toEqual(payload)
})

test('retained check IDs require the exact App, name and current head before update', async () => {
  for (const value of [check(99, payload.external_id, 18), check(99, payload.external_id, appId, otherHead),
    {...check(99, payload.external_id), name: 'A different check'}]) {
    const f = fixture(call => call.path.startsWith('commits/') ? inventory([value]) : reply(value))
    await expect(f.github.deliver(99, payload)).rejects.toThrow('ownership differs')
    expect(f.calls.every(call => call.method === 'GET')).toBe(true)
  }
  const wrongInventory = fixture(call => call.path.startsWith('commits/') ? inventory([check(99, payload.external_id, appId, otherHead)]) : reply(check(99, payload.external_id, appId, otherHead)))
  await expect(wrongInventory.github.deliver(undefined, payload, true)).rejects.toThrow('ownership differs')
  expect(wrongInventory.calls.every(call => call.method === 'GET')).toBe(true)
})

test('authenticated context uses complete same-head open dev/staging PR inventory and routine labels only', async () => {
  const pr = {number: 12, state: 'open', head: {sha: head, ref: 'feature', repo: {full_name: ROUTINE_CHECK_REPOSITORY}},
    base: {ref: 'staging'}, labels: [{name: 'routine:z'}, {name: 'bug:framework'}, {name: 'routine:a'}]}
  const first = Array.from({length: 100}, (_, index) => ({...pr, number: index + 1, head: {...pr.head, sha: otherHead}}))
  first[0] = pr
  const peer = {...pr, number: 13, base: {ref: 'dev'}}
  const f = fixture(call => reply(call.path === 'pulls/12' ? pr : call.path.endsWith('page=1') ? first :
    [peer, {...pr, number: 14, base: {ref: 'main'}}, {...pr, number: 15, head: {...pr.head, sha: otherHead}}]))
  expect(await f.github.context(12)).toEqual({number: 12, headSha: head, headRef: 'feature', baseRef: 'staging',
    sameRepository: true, open: true, labels: ['routine:a', 'routine:z'], peers: [12, 13]})
  expect(f.calls.map(call => call.path)).toEqual(['pulls/12', 'pulls?state=open&per_page=100&page=1', 'pulls?state=open&per_page=100&page=2'])
  const incomplete = fixture(() => reply(first))
  await expect(incomplete.github.context(12)).rejects.toThrow() // The individual PR response must also be valid.
  const capped = fixture(call => reply(call.path === 'pulls/12' ? pr : first))
  await expect(capped.github.context(12)).rejects.toThrow('bounded ownership inventory')
  expect(capped.calls).toHaveLength(11)
})

test('permission validation refuses malformed actors without requests and only accepts write capabilities', async () => {
  for (const permission of ['admin', 'maintain', 'write', 'read', 'triage', 'none']) {
    const f = fixture(() => reply({permission}))
    expect(await f.github.permission('valid-actor')).toBe(['admin', 'maintain', 'write'].includes(permission))
    expect(f.calls[0]!.path).toBe('collaborators/valid-actor/permission')
  }
  const invalid = fixture(() => {throw Error('must not request')})
  for (const actor of ['../someone', 'bad/name', '', '-bad', 'x'.repeat(101)]) expect(await invalid.github.permission(actor)).toBe(false)
  expect(invalid.calls).toHaveLength(0)
})

test('build requests pin both existing producers to the authenticated PR while using only source scope', async () => {
  for (const platform of ['android', 'ios-on-mac', 'asg'] as const) {
    const f = fixture(() => new Response(null, {status: 204}))
    const context: PrRoutineContext = {number: 12, headSha: head, baseRef: 'staging', headRef: 'feature',
      sameRepository: true, open: true, labels: [], peers: [12]}
    await f.github.requestBuild(platform, context, 'c'.repeat(64))
    expect(f.calls.map(call => call.path)).toEqual([platform === 'asg' ? 'actions/workflows/mentra-asg-client-build.yml/dispatches' : `actions/workflows/mentra-app-${platform === 'android' ? 'android' : 'ios'}-build.yml/dispatches`])
    expect(f.scopes).toEqual(['source'])
    for (const call of f.calls) expect(call.body).toEqual({ref: 'dev', inputs: {routine_pr: '12', routine_head_sha: head, routine_base: 'staging', routine_operation: 'c'.repeat(64)}})
  }
})

test('transport failure never leaks provider text or falls through to a write', async () => {
  const f = fixture(() => {throw Error('provider-sensitive-diagnostic')})
  try {await f.github.deliver(undefined, payload, true); throw Error('unexpected success')}
  catch (error) {expect(String(error)).toContain('delivery is unavailable'); expect(String(error)).not.toContain('provider-sensitive-diagnostic')}
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

test('producer reconciliation uses exact operation/title/repository and refuses incomplete or duplicate history', async () => {
  const operation = 'c'.repeat(64), context: PrRoutineContext = {number: 12, headSha: head, baseRef: 'dev', headRef: 'feature', sameRepository: true, open: true, labels: [], peers: [12]}
  const row = {id: 44, display_title: `Routine PR #12 ${head} dev ${operation}`, path: '.github/workflows/mentra-asg-client-build.yml', event: 'workflow_dispatch', head_branch: 'dev', status: 'completed', conclusion: 'failure', repository: {full_name: ROUTINE_CHECK_REPOSITORY}, head_repository: {full_name: ROUTINE_CHECK_REPOSITORY}}
  const f = fixture(() => reply({workflow_runs: [row, {...row, id: 45, display_title: row.display_title + 'bad'}]}))
  expect(await f.github.producer('asg', context, operation)).toEqual({id: 44, failed: true})
  expect(f.calls.every(call => call.method === 'GET')).toBe(true); expect(f.scopes).toEqual(['source'])
  const duplicate = fixture(() => reply({workflow_runs: [row, {...row, id: 45}]}))
  await expect(duplicate.github.producer('asg', context, operation)).rejects.toThrow('ambiguous')
  let page = 0
  const capped = fixture(() => reply({workflow_runs: Array.from({length: 100}, (_, index) => ({...row, id: ++page * 100 + index, display_title: 'unrelated'}))}))
  await expect(capped.github.producer('asg', context, operation)).rejects.toThrow('bounded')
  expect(capped.calls).toHaveLength(5)
})

// GitHub retains omitted terminal fields on PATCH and a conclusion keeps the run completed.
function nativeFixture() {
  const checks: Array<ReturnType<typeof check>> = []
  let lost = false
  const f = fixture(call => {
    if (call.path.startsWith('commits/')) return inventory(checks)
    if (call.method === 'POST') {
      const row = {...check(99 + checks.length, String(call.body!.external_id)), ...call.body!}
      if (row.conclusion) row.status = 'completed'
      checks.push(row)
      if (lost) {lost = false; throw Error('create committed before connection loss')}
      return reply(row, 201)
    }
    const row = checks.find(row => call.path === `check-runs/${row.id}`)!
    if (call.method === 'PATCH') {
      Object.assign(row, call.body)
      if (row.conclusion) row.status = 'completed'
    }
    return reply(row)
  })
  return {...f, checks, loseCreate() {lost = true}}
}

test('new coverage and native rerun get one pending native check each while terminal history is unchanged', async () => {
  const f = nativeFixture(), finished = '2026-10-12T00:00:01Z'
  const empty: CheckPayload = {...payload, external_id: 'gate-one:1:1', status: 'completed', conclusion: 'success', completed_at: finished}
  expect(await f.github.deliver(undefined, empty, true)).toBe(99)
  const old = structuredClone(f.checks[0])
  const queued: CheckPayload = {...payload, external_id: 'gate-one:2:1', status: 'queued'}
  expect(await f.github.deliver(undefined, queued, true)).toBe(100)
  expect(f.checks[1]).toMatchObject({status: 'queued', conclusion: null, completed_at: null, external_id: queued.external_id})
  expect(f.checks[0]).toEqual(old)
  expect(await f.github.deliver(100, {...queued, status: 'in_progress'})).toBe(100)
  expect(await f.github.deliver(100, {...queued, status: 'completed', conclusion: 'failure', completed_at: finished})).toBe(100)
  const rerun: CheckPayload = {...queued, external_id: 'gate-one:2:2'}
  f.loseCreate()
  await expect(f.github.deliver(undefined, rerun, true)).rejects.toThrow('delivery is unavailable')
  expect(await f.github.deliver(undefined, rerun, false)).toBe(101)
  expect(f.checks).toHaveLength(3)
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(3)
  expect(f.checks[2]).toMatchObject({status: 'queued', conclusion: null, completed_at: null})
  expect(f.checks[0]).toEqual(old)
})

test('sticky terminal native state is not acknowledged as a pending delivery', async () => {
  const f = nativeFixture(), completed: CheckPayload = {...payload, status: 'completed', conclusion: 'success', completed_at: '2026-10-12T00:00:01Z'}
  await f.github.deliver(undefined, completed, true)
  await expect(f.github.deliver(99, payload)).rejects.toThrow('did not retain the intended')
  expect(f.checks[0]).toMatchObject({status: 'completed', conclusion: 'success', completed_at: completed.completed_at})
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
})

test('delivery receipt must retain exact native state and ownership before acknowledgement', async () => {
  for (const changed of [{id: 101}, {external_id: 'other'}, {head_sha: otherHead}, {app: {id: 18}},
    {status: 'completed'}, {conclusion: 'success'}, {completed_at: '2026-10-12T00:00:01Z'}]) {
    const f = fixture(call => call.method === 'PATCH' ? reply({...check(99, payload.external_id), ...payload, ...changed}) :
      call.path.startsWith('commits/') ? inventory([check(99, payload.external_id)]) : reply(check(99, payload.external_id)))
    await expect(f.github.deliver(99, payload)).rejects.toThrow('did not retain the intended')
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  }
  const missing = fixture(call => call.method === 'POST' ? reply({id: 99}) : inventory([]))
  await expect(missing.github.deliver(undefined, payload, true)).rejects.toThrow()
})

test('a retained historical native ID cannot be patched into the current generation', async () => {
  const f = fixture(call => call.path.startsWith('commits/') ? inventory([check(99, 'gate-one:1:1')]) : reply(check(99, 'gate-one:1:1')))
  await expect(f.github.deliver(99, {...payload, external_id: 'gate-one:2:1'})).rejects.toThrow('ownership differs')
  expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

test('paginated native history supports current updates and lost-create reconciliation without another POST', async () => {
  const history = Array.from({length: 100}, (_, index) => check(index + 1, `gate-one:${index}:1`))
  let current: ReturnType<typeof check> | undefined, loseCreate = true
  const f = fixture(call => {
    if (call.path.startsWith('commits/')) {
      const page = Number(new URLSearchParams(call.path.split('?')[1]).get('page'))
      const rows = current ? [...history, current] : history
      return inventory(rows.slice((page - 1) * 100, page * 100), rows.length)
    }
    if (call.method === 'POST') {
      current = check(101, payload.external_id)
      if (loseCreate) {loseCreate = false; throw Error('native create committed before connection loss')}
      throw Error('duplicate create')
    }
    expect(call.path).toBe('check-runs/101')
    if (call.method === 'PATCH') Object.assign(current!, call.body)
    return reply(current)
  })
  await expect(f.github.deliver(undefined, payload, true)).rejects.toThrow('retained operation will reconcile')
  expect(await f.github.deliver(undefined, payload, false)).toBe(101)
  expect(await f.github.deliver(101, payload)).toBe(101)
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(f.calls.filter(call => call.method === 'PATCH')).toHaveLength(2)
  expect(f.calls.filter(call => call.path.startsWith('commits/') && call.path.endsWith('page=2'))).toHaveLength(3)
  expect(history.map(row => row.external_id)).toEqual(Array.from({length: 100}, (_, index) => `gate-one:${index}:1`))
})

test('duplicate current receipts across pages and changing or oversized history refuse every native write', async () => {
  const first = Array.from({length: 100}, (_, index) => check(index + 1, `history:${index}`))
  first[0] = check(1, payload.external_id)
  const duplicate = fixture(call => inventory(call.path.endsWith('page=1') ? first : [check(101, payload.external_id)], 101))
  await expect(duplicate.github.deliver(1, payload)).rejects.toThrow('ambiguous')
  expect(duplicate.calls).toHaveLength(2)
  const overlapping = fixture(call => inventory(call.path.endsWith('page=1') ? first : [first[0]!], 101))
  await expect(overlapping.github.deliver(1, payload)).rejects.toThrow('changed during reconciliation')
  const changing = fixture(call => inventory(call.path.endsWith('page=1') ? first : [check(101, payload.external_id)], call.path.endsWith('page=1') ? 101 : 102))
  await expect(changing.github.deliver(1, payload)).rejects.toThrow('changed during reconciliation')
  const oversized = fixture(() => inventory(first, 1001))
  await expect(oversized.github.deliver(1, payload)).rejects.toThrow('bounded reconciliation inventory')
  expect(oversized.calls).toHaveLength(1)
  for (const f of [duplicate, overlapping, changing, oversized]) expect(f.calls.every(call => call.method === 'GET')).toBe(true)
})

test('GitHub whole-second terminal receipt matches the retained millisecond intent without accepting another second', async () => {
  // Exact timestamp pair from a saved native cancelled response; other values are synthetic.
  const completed: CheckPayload = {...payload, status: 'completed', conclusion: 'cancelled',
    completed_at: '2026-10-12T04:11:36.363Z'}
  const native = {...check(99, payload.external_id), status: 'completed', conclusion: 'cancelled',
    completed_at: '2026-10-12T04:11:36Z'}
  for (const method of ['POST', 'PATCH']) {
    const f = fixture(call => call.method === method ? reply(native, method === 'POST' ? 201 : 200) :
      call.path.startsWith('commits/') ? inventory(method === 'PATCH' ? [check(99, payload.external_id)] : []) : reply(native))
    expect(await f.github.deliver(method === 'PATCH' ? 99 : undefined, completed, method === 'POST')).toBe(99)
    expect(f.calls.filter(call => call.method === method)).toHaveLength(1)
  }
  for (const timestamp of ['2026-10-12T04:11:35Z', '2026-10-12T04:11:37Z', null, 'invalid']) {
    const f = fixture(call => call.method === 'PATCH' ? reply({...native, completed_at: timestamp}) :
      call.path.startsWith('commits/') ? inventory([check(99, payload.external_id)]) : reply(native))
    await expect(f.github.deliver(99, completed)).rejects.toThrow()
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(0)
  }
})

test('rerun authority follows the last actual label applier rather than unrelated PR event actors', async()=>{
 const label='rerun:gallery:r:original',pr={number:12,state:'open',head:{sha:head,ref:'feature',repo:{full_name:ROUTINE_CHECK_REPOSITORY}},base:{ref:'dev'},labels:[{name:label}]}
 const f=fixture(call=>reply(call.path==='pulls/12'?pr:call.path.startsWith('issues/')?[
  {event:'labeled',label:{name:label},actor:{login:'writer'}},
  {event:'unlabeled',label:{name:label},actor:{login:'writer'}},
  {event:'labeled',label:{name:label},actor:{login:'triage-user'}},
  {event:'head_ref_force_pushed',actor:{login:'writer'}},
 ]:[pr]))
 expect((await f.github.context(12)).labelActors).toEqual({[label]:'triage-user'})
 expect(f.calls.filter(call=>call.path.startsWith('issues/')).map(call=>call.path)).toEqual(['issues/12/events?per_page=100&page=1'])
})
