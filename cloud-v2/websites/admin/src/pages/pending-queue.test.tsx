import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {PendingQueueSection} from './pending-queue';
import type {PendingQueuePage} from '../../../../packages/core/src/types/test-pending-queue.types';
test('pending queue shows exact compatible lane states, unknown preparation and pagination', () => {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const data: PendingQueuePage = {total:71, observedAt:new Date().toISOString(), nextCursor:'request-50', items:[
    {requestId:'request',routineId:'check',state:'awaiting-runner',platform:'android',compatibilityKnown:true,
      build:{channel:'pr',prNumber:698,headSha:'a'.repeat(40)}, platformCandidates:[],compatibleLanes:[
        {hostId:'mini',laneId:'android',platform:'android',glassesModels:['mentra-live'],state:'running',dispatchMode:'automatic',fresh:true},
        {hostId:'air',laneId:'android',platform:'android',glassesModels:[],state:'idle',dispatchMode:'paused',fresh:false}]},
    {requestId:'preparation',routineId:'prepare',state:'awaiting-source',compatibilityKnown:false,compatibleLanes:[],platformCandidates:[]},
  ]};
  client.setQueryData(['test-pending-queue',undefined],data);
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><PendingQueueSection /></QueryClientProvider>);
  for(const text of ['Pending queue','71','PR #698','Compatible lanes','Running','Stale report','Paused','Compatibility pending source preparation','Next page']) expect(html).toContain(text);
  expect(html).toContain('/?testRun=request'); expect(html).toContain('hostId=mini&amp;laneId=android');
  client.clear();
});
test('empty queue only reports jobs waiting to start', () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  client.setQueryData(['test-pending-queue', undefined], {total: 0, observedAt: new Date().toISOString(), items: []} satisfies PendingQueuePage);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PendingQueueSection /></QueryClientProvider>);
  expect(html).toContain('Waiting to start.');
  expect(html).toContain('No pending requests.');
  expect(html).not.toContain('Cancellation');
  expect(html).not.toContain('active requests');
  client.clear();
});
test('pending queue exposes stage and an expected/observed checklist with owner and next action', () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  const item = {requestId: 'original', state: 'awaiting-runner', reason: 'Waiting for the original return', compatibilityKnown: true,
    compatibleLanes: [], platformCandidates: [], diagnosis: {stage: 'Candidate check and return', nextAction: 'Inspect the owning lane report',
      conditions: [{label: 'Original claim', status: 'waiting' as const, expected: 'Authenticated return', observed: 'Original check remains pending',
        hostId: 'mini', laneId: 'mac', resourceId: 'exact-resource', owner: 'run:original'}]}};
  client.setQueryData(['test-pending-queue', undefined], {total: 1, observedAt: new Date().toISOString(), items: [item]} satisfies PendingQueuePage);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PendingQueueSection /></QueryClientProvider>);
  for (const value of ['Waiting stage:','Candidate check and return','Expected:','Observed:','Authenticated return','exact-resource','run:original','Next action:']) expect(html).toContain(value);
  client.clear();
});
