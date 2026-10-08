import {expect, spyOn, test} from 'bun:test';
import {TestRequestModel} from '../models/test-request.model';
import {TestPendingQueueService} from './test-pending-queue.service';
import {hostCancellationDeliveryFilter, hostRequestDeliveryFilter, pendingRequestFilter} from './test-request-activity';

const now = Date.parse('2026-10-08T12:00:00Z');
type Document = Record<string, unknown> & {requestId: string; state: string};

// Apply the operators used by this query so the service tests exercise both its
// selection and count against the same persisted documents.
function matches(row: Document, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === 'object') {
      return Object.entries(condition).every(([operator, operand]) => {
        if (operator === '$exists') return Object.hasOwn(row, key) === operand;
        if (operator === '$in') return (operand as unknown[]).includes(value);
        if (operator === '$gt') return typeof value === 'string' && value > String(operand);
        throw new Error(`Unexpected query operator: ${operator}`);
      });
    }
    return value === condition;
  });
}

async function pageFor(documents: Document[], cursor?: string) {
  const filters: Record<string, unknown>[] = [];
  const find = spyOn(TestRequestModel, 'find').mockImplementation(((filter: Record<string, unknown>) => {
    filters.push(filter);
    let limit = Infinity;
    return {sort(value: unknown) {expect(value).toEqual({requestId: 1}); return this;},
      limit(value: number) {limit = value; return this;}, read(value: string) {expect(value).toBe('primary'); return this;},
      readConcern(value: string) {expect(value).toBe('majority'); return this;},
      async lean() {return documents.filter(row => matches(row, filter)).sort((a, b) => a.requestId.localeCompare(b.requestId)).slice(0, limit);}};
  }) as any);
  const count = spyOn(TestRequestModel, 'countDocuments').mockImplementation(((filter: Record<string, unknown>) => {
    expect(filter).toEqual(pendingRequestFilter);
    return {read() {return this;}, readConcern() {return this;},
      then(resolve: (value: number) => unknown) {return Promise.resolve(documents.filter(row => matches(row, filter)).length).then(resolve);}};
  }) as any);
  try {
    const page = await new TestPendingQueueService({list: async () => []} as any, () => now).list(cursor);
    expect(filters).toEqual([{...pendingRequestFilter, ...(cursor ? {requestId: {$gt: cursor}} : {})}]);
    expect(Object.keys(page).sort()).toEqual(['items', 'observedAt', 'total', ...(page.nextCursor ? ['nextCursor'] : [])].sort());
    return page;
  } finally {find.mockRestore(); count.mockRestore();}
}

test.each(['awaiting-source', 'awaiting-runner', 'preparing', 'queued'])('%s appears in pending rows and count', async state => {
  const page = await pageFor([{requestId: 'waiting', state}]);
  expect(page.total).toBe(1);
  expect(page.items.map(item => item.requestId)).toEqual(['waiting']);
});

test.each(['accepted', 'running', 'terminal', 'malformed'])('%s is never pending', async state => {
  const page = await pageFor([{requestId: 'other', state}, {requestId: 'waiting', state: 'queued'}]);
  expect(page.total).toBe(1);
  expect(page.items.map(item => item.requestId)).toEqual(['waiting']);
});

test.each(['hostCancellation', 'fleetCancellation', 'preparationCancellation', 'hostRejection', 'preparationRejection',
  'terminalStatus', 'dispatchCompletion'])('%s excludes a persisted waiting-state row', async fence => {
  const page = await pageFor([{requestId: 'fenced', state: 'queued', [fence]: {}}, {requestId: 'waiting', state: 'queued'}]);
  expect(page.total).toBe(1);
  expect(page.items.map(item => item.requestId)).toEqual(['waiting']);
});

test('cancelled requests stay out with or without acknowledgement and retained repair custody', async () => {
  const page = await pageFor([
    {requestId: 'stop-pending', state: 'queued', hostCancellation: {reason: 'Stop'}, cancellationAcknowledged: false},
    {requestId: 'stop-acknowledged', state: 'accepted', hostCancellation: {reason: 'Stop'}, cancellationAcknowledged: true},
    {requestId: 'repair-held', state: 'queued', fleetCancellation: {reason: 'Stop'}, fleetBinding: {hostId: 'host', laneId: 'lane'}},
    {requestId: 'cancelled-terminal', state: 'terminal', terminalStatus: 'cancelled'},
  ]);
  expect(page.items).toEqual([]);
  expect(page.total).toBe(0);
});

test('malformed durable fences fail closed rather than appearing as pending', async () => {
  const page = await pageFor([{requestId: 'null-cancellation', state: 'queued', hostCancellation: null},
    {requestId: 'null-terminal', state: 'preparing', terminalStatus: null}]);
  expect(page.total).toBe(0);
});

test('pending pagination and total share the same waiting-only predicate', async () => {
  const documents = Array.from({length: 52}, (_, index) => ({requestId: `request-${String(index).padStart(2, '0')}`, state: 'queued'}));
  documents.push({requestId: 'accepted', state: 'accepted'}, {requestId: 'running', state: 'running'});
  const first = await pageFor(documents);
  expect(first.items).toHaveLength(50);
  expect(first.total).toBe(52);
  expect(first.nextCursor).toBe('request-49');
  const second = await pageFor(documents, first.nextCursor);
  expect(second.items.map(item => item.requestId)).toEqual(['request-50', 'request-51']);
  expect(second.total).toBe(52);
  expect(second.nextCursor).toBeUndefined();
});

test('host delivery and cancellation acknowledgement predicates remain literal', () => {
  expect(hostRequestDeliveryFilter('host')).toEqual({hostId: 'host', state: 'queued'});
  expect(hostCancellationDeliveryFilter()).toEqual({hostCancellation: {$exists: true}, cancellationAcknowledged: {$ne: true}});
});
