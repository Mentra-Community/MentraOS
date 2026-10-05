import {expect, test} from 'bun:test'
import {RoutineWorkNotification} from './routine-work-notification'
import type {TestRunGithubApp} from './test-run-github-app'
import type {RoutineWorkDelivery} from './routine-work.service'

test('status notification carries only the existing work identity to the trusted dev workflow', async () => {
  const scopes: string[] = [],
    calls: Array<{url: string; init: RequestInit}> = []
  const app = {
    async token(scope: string) {
      scopes.push(scope)
      return 'secret'
    },
  }
  const notification = new RoutineWorkNotification(app as TestRunGithubApp, async (url, init) => {
    calls.push({url: String(url), init: init!})
    return new Response(null, {status: 204})
  })
  await notification.publish({
    workId: 'one',
    work: {origin: {repository: 'Mentra-Community/MentraOS'}, privateDetails: 'not sent'},
  } as unknown as RoutineWorkDelivery)
  expect(scopes).toEqual(['source'])
  expect(calls[0]?.url).toEndWith('/notify-routine-work.yml/dispatches')
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ref: 'dev', inputs: {work_id: 'one'}})
  expect(calls[0]?.init.redirect).toBe('error')
  const failed = new RoutineWorkNotification(app as TestRunGithubApp, async () => new Response(null, {status: 403}))
  await expect(failed.publish({workId: 'one', work: {origin: {}}} as RoutineWorkDelivery)).rejects.toThrow(
    'unavailable',
  )
})
