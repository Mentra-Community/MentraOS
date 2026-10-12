import {createHmac} from 'node:crypto'
import {expect, test} from 'bun:test'
import {createPrRoutineCheckApi, verifyRoutineWebhook} from './pr-routine-check.api'

const secret = 'independent-webhook-fixture-secret-32-characters'
const sign = (value: string) => `sha256=${createHmac('sha256', secret).update(value).digest('hex')}`
test('webhook signature authenticates exact raw bytes and rejects absent/malformed signatures', () => {
  const bytes = Buffer.from('{"action":"opened"}')
  expect(verifyRoutineWebhook(bytes, sign(bytes.toString()), secret)).toBe(true)
  for (const signature of [undefined, 'sha1=' + 'a'.repeat(40), 'sha256=' + 'a'.repeat(64)]) expect(verifyRoutineWebhook(bytes, signature, secret)).toBe(false)
  expect(verifyRoutineWebhook(Buffer.from(bytes.toString() + ' '), sign(bytes.toString()), secret)).toBe(false)
})
test('actual Hono webhook routes only own App/install controls and hides transport errors', async () => {
  const controls: unknown[] = [], intakes: unknown[] = []
  const app = createPrRoutineCheckApi({async control(value: unknown) {controls.push(value); return {accepted: true}},
    async intake(...value: unknown[]) {intakes.push(value); return {accepted: true}}} as any,
    {applicationId: 17, installationId: 19} as any, () => secret)
  const payload = {repository: {full_name: 'Mentra-Community/MentraOS'}, installation: {id: 19}, sender: {login: 'employee'},
    action: 'rerequested', check_run: {id: 23, external_id: 'pr-check-example:1:2', head_sha: 'a'.repeat(40), app: {id: 17}}}
  const send = (value: unknown, event = 'check_run') => {const body = JSON.stringify(value); return app.request('/webhook', {method: 'POST', body,
    headers: {'x-github-event': event, 'x-github-delivery': 'delivery-one', 'x-hub-signature-256': sign(body)}})}
  expect((await send(payload)).status).toBe(200); expect(controls).toHaveLength(1)
  expect((await send({...payload, check_run: {...payload.check_run, app: {id: 33}}})).status).toBe(400)
  expect((await send({...payload, installation: {id: 33}})).status).toBe(400)
  expect((await send({...payload, repository: {full_name: 'external/repository'}})).status).toBe(400)
  expect(controls).toHaveLength(1); expect(intakes).toHaveLength(0)
  const cancel = {...payload, action: 'requested_action', requested_action: {identifier: 'cancel'}}
  expect((await send(cancel)).status).toBe(200); expect(controls).toHaveLength(2)
  expect((await send({...cancel, requested_action: {identifier: 'shell'}})).status).toBe(400)
})
