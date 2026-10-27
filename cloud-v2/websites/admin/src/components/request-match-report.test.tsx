import {expect, test} from 'bun:test'
import {renderToStaticMarkup} from 'react-dom/server'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import type {TestRequestMatchReport} from '../../../../packages/core/src/types/test-request-match.types'
import {RequestMatchDetails, RequestMatchReport} from './request-match-report'

const report: TestRequestMatchReport = {requestId: 'original', state: 'awaiting-runner', observedAt: '2026-10-27T17:00:00Z', stage: 'Candidate check and return',
  reason: 'The original check is waiting for authentic return.', nextAction: 'Inspect its exact owner and original return.', identity: {inputSha256: 'a'.repeat(64)},
  requirements: {effective: {platform: 'android', resources: [{kind: 'phone', capabilities: ['backend-connectivity']},
    {kind: 'app', capabilities: ['relaunch']}, {kind: 'recorder', capabilities: [], storage: {minimumAvailableBytes: 3254779904}}]},
    declaredResources: [{kind: 'phone', capabilities: ['backend-connectivity']}, {kind: 'app', capabilities: ['relaunch']},
      {kind: 'recorder', capabilities: [], storage: {minimumAvailableBytes: 100}}], human: ['English display', 'Email/password provisioned account'],
    minimumRoutineApiVersion: 15, estimatedOutputBytes: 1107296256},
  lanes: [{hostId: 'mini', laneId: 'android', platform: 'android', state: 'idle', dispatchMode: 'automatic', observedAt: '2026-10-27T16:59:59Z',
    candidateMatch: 'blocked', executionCompatibility: 'unknown', conditions: [{id: 'source', label: 'Source compatibility', category: 'source', status: 'match', expected: 'API15', observed: 'API110'}],
    resources: [{kind: 'phone', resourceId: 'exact-phone', conditions: [{id: 'phone-check', label: 'Phone observation', category: 'physical', status: 'unknown',
      expected: 'Exact current returned check', observed: 'No observation; absence is not denial'}]}, {kind: 'app', resourceId: 'exact-app', conditions: []},
      {kind: 'recorder', resourceId: 'exact-recorder', owner: {id: 'foreign-original', kind: 'run', hostId: 'mini'}, conditions: [{id: 'claim', label: 'Current claim', category: 'ownership',
        status: 'blocked', expected: 'Authentic return', observed: 'foreign-original'}]}]}],
  summary: {candidateLanes: 0, structurallyCompatibleLanes: 1, resources: [{kind: 'phone', presentLanes: 1, capabilityMatchingLanes: 1}]},
  limits: ['All resources must match on the same lane.']}
test('the lane matrix renders exact frozen conditions with separate unknown physical and foreign ownership facts', () => {
  const html = renderToStaticMarkup(<RequestMatchDetails report={report} jsonPath="/api/admin/test-runs/requests/original/matching" />)
  for (const value of ['Lane × requested resource matrix', 'English display', 'Email/password provisioned account', 'backend-connectivity', 'relaunch',
    'None declared', '100 / 3254779904 bytes', 'Routine API: 15', 'Source compatibility', 'absence is not denial', 'run:foreign-original', 'same lane', 'Read the same JSON report']) expect(html).toContain(value)
  expect(html).not.toContain('physical denial confirmed')
})
test('collapsed diagnostics do not fetch host matrices for every activity or queue row', () => {
  const client = new QueryClient(), html = renderToStaticMarkup(<QueryClientProvider client={client}><RequestMatchReport requestId="original" /></QueryClientProvider>)
  expect(html).toContain('Requirements and lane checklist'); expect(html).not.toContain('Loading current lane conditions')
  expect(client.getQueryState(['request-matching', 'original'])?.fetchStatus).toBe('idle')
})
