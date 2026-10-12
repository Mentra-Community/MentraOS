import {expect, test} from 'bun:test'
import {GithubPrRoutineChecks} from './pr-routine-check-github'
import {TestRunGithubApp} from './test-run-github-app'
import {ROUTINE_CHECK_NAME, ROUTINE_CHECK_REPOSITORY, type CheckPayload, type PrRoutineContext} from '../types/pr-routine-check.types'

const head = 'a'.repeat(40), otherHead = 'b'.repeat(40), appId = 17
const payload: CheckPayload = {name: ROUTINE_CHECK_NAME, head_sha: head, external_id: 'gate-one:2',
  status: 'in_progress', started_at: '2026-10-12T00:00:00Z', details_url: 'https://admin.dev.mentraglass.com/?testRuns=1',
  output: {title: 'Routine tests', summary: 'Waiting for routine results'}}
const check = (id = 99, external_id = 'gate-one:1', applicationId = appId, head_sha = head) =>
  ({id, external_id, name: ROUTINE_CHECK_NAME, head_sha, app: {id: applicationId}})
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
  expect(await f.github.deliver(undefined, {...payload, external_id: 'gate-one:3'}, false)).toBe(99)
  expect(f.calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET', 'GET', 'GET', 'PATCH'])
  expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(f.calls.at(-1)!.body).toMatchObject({external_id: 'gate-one:3', output: payload.output})
  expect(f.scopes.every(scope => scope === 'checks')).toBe(true)
})

test('uncertain creation with no visible receipt cannot repeat POST', async () => {
  const f = fixture(() => inventory([]))
  await expect(f.github.deliver(undefined, payload, false)).rejects.toThrow('without repeating the create')
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})

test('duplicate own-gate receipts and incomplete history block writes', async () => {
  for (const response of [() => inventory([check(1), check(2)]), () => inventory([check(1)], 2)]) {
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
    const f = fixture(() => reply(value))
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
  for (const platform of ['android', 'ios-on-mac'] as const) {
    const f = fixture(() => new Response(null, {status: 204}))
    const context: PrRoutineContext = {number: 12, headSha: head, baseRef: 'staging', headRef: 'feature',
      sameRepository: true, open: true, labels: [], peers: [12]}
    await f.github.requestBuild(platform, context)
    expect(f.calls.map(call => call.path)).toEqual(['actions/workflows/mentra-asg-client-build.yml/dispatches',
      `actions/workflows/mentra-app-${platform === 'android' ? 'android' : 'ios'}-build.yml/dispatches`])
    expect(f.scopes).toEqual(['source', 'source'])
    for (const call of f.calls) expect(call.body).toEqual({ref: 'dev', inputs: {routine_pr: '12', routine_head_sha: head, routine_base: 'staging'}})
  }
})

test('transport failure never leaks provider text or falls through to a write', async () => {
  const f = fixture(() => {throw Error('provider-sensitive-diagnostic')})
  try {await f.github.deliver(undefined, payload, true); throw Error('unexpected success')}
  catch (error) {expect(String(error)).toContain('delivery is unavailable'); expect(String(error)).not.toContain('provider-sensitive-diagnostic')}
  expect(f.calls.map(call => call.method)).toEqual(['GET'])
})
