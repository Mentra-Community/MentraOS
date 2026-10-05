import {TestRunGithubApp} from './test-run-github-app'
import type {RoutineWorkDelivery} from './routine-work.service'

/** Delivery/status commits remain valid if GitHub is unavailable; an exact receipt retry can notify again. */
export class RoutineWorkNotification {
  constructor(
    private readonly app = new TestRunGithubApp(),
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ) {}
  async publish(row: RoutineWorkDelivery): Promise<void> {
    if (!row.work.origin) return
    const response = await this.transport(
      'https://api.github.com/repos/Mentra-Community/MentraOS/actions/workflows/notify-routine-work.yml/dispatches',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Authorization': `Bearer ${await this.app.token('source')}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ref: 'dev', inputs: {work_id: row.workId}}),
      },
    )
    if (response.status !== 204) throw new Error('Authoring status notification is unavailable')
  }
}
