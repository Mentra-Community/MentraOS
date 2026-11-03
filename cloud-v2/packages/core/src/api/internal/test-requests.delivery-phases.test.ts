import {expect, spyOn, test} from 'bun:test';
import {Hono} from 'hono';
import {randomUUID} from 'node:crypto';
import {createTestRequestsApi} from './test-requests.api';
import {TestRequestService, type TestRequestRepository} from '../../services/test-request.service';
import {testFrameworkBinding} from '../../testing/framework-fixtures';
import {requestContext} from '../middleware/context.middleware';
import type {AppEnv} from '../../types/hono.types';

const credential = 'synthetic-controller-credential-' + 'x'.repeat(32);
const headers = {authorization: `Bearer ${credential}`};
const digest = 'a'.repeat(64);
const owned = {jobId: 'original', laneId: 'mac', inputSha256: digest, ownerId: 'passive-owner', generation: 4,
  binding: testFrameworkBinding(), controller: {incarnation: 'reporter', generation: 1}};

for (const descriptor of ['ownedQualification', 'unclaimedQualification'] as const) {
  test(`exact ${descriptor} revalidation does not read unrelated delivery work`, async () => {
    const calls: string[] = [];
    class Service extends TestRequestService {
      override async queued(): Promise<never> {
        calls.push('delivery-queue');
        throw Object.assign(new Error('synthetic queue timeout'), {name: 'MongoOperationTimeoutError'});
      }
    }
    const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: credential}), undefined, undefined,
      {async qualificationTargets() {calls.push('exact-qualification'); return [];}});
    const value = descriptor === 'ownedQualification' ? owned : {jobId: 'original', inputSha256: digest};
    const query = new URLSearchParams({qualificationTargets: '1', [descriptor]: JSON.stringify(value), limit: '1'});
    const response = await api.request(`/?${query}`, {headers});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({requests: [], preparations: [], dispatchCompletions: [], nextCursor: null,
      qualificationTargets: [], [descriptor]: value});
    expect(calls).toEqual(['exact-qualification']);
  });
}

test('ordinary delivery awaits its original queue, completions, framework and preparations', async () => {
  const calls: string[] = [];
  const unused = async (): Promise<never> => {throw new Error('unexpected mutation');};
  const repository: TestRequestRepository = {
    insert: unused, get: unused, accept: unused, reject: unused, cancel: unused, acknowledgeCancellation: unused, cancellations: unused,
    async queued() {calls.push('queued-read'); return [];},
    async pendingDispatchCompletions() {calls.push('unfinished-dispatch-completions-read'); return [];},
    async preparations() {calls.push('preparations-read'); return [];},
  };
  const service = new TestRequestService(repository, undefined, null,
    {async frameworkObservation() {calls.push('framework-observation-read'); return null;}});
  const api = createTestRequestsApi(service, () => JSON.stringify({mini: credential}));
  const response = await api.request('/', {headers});
  expect(response.status).toBe(200);
  expect(calls).toEqual(['queued-read', 'unfinished-dispatch-completions-read', 'framework-observation-read', 'preparations-read']);
});

test('an optional minimum failure rejects an already built ordinary delivery page', async () => {
  const calls: string[] = [];
  class Service extends TestRequestService {
    override async queued() {calls.push('built-queue'); return {requests: [], preparations: [], dispatchCompletions: [], nextCursor: null};}
    override async preparationFrameworkMinimum(): Promise<never> {
      calls.push('minimum-read'); throw Object.assign(new Error('synthetic minimum timeout'), {name: 'MongoOperationTimeoutError'});
    }
  }
  const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: credential}));
  const response = await api.request('/?preparationFrameworkMinimum=1', {headers});
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error: 'request_delivery_unavailable'});
  expect(calls).toEqual(['built-queue', 'minimum-read']);
});

test('exact revalidation still refuses an unavailable qualification authority', async () => {
  const calls: string[] = [];
  class Service extends TestRequestService {
    override async queued(): Promise<never> {calls.push('unrelated-queue'); throw new Error('unexpected queue read');}
  }
  const api = createTestRequestsApi(new Service(), () => JSON.stringify({mini: credential}), undefined, undefined,
    {async qualificationTargets(): Promise<never> {calls.push('qualification'); throw new Error('qualification unavailable');}});
  const query = new URLSearchParams({qualificationTargets: '1', ownedQualification: JSON.stringify(owned)});
  const response = await api.request(`/?${query}`, {headers});
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error: 'request_delivery_unavailable'});
  expect(calls).toEqual(['qualification']);
});

for (const failedPhase of ['queued-request-read', 'unfinished-dispatch-completions-read', 'accepted-framework-observation-read',
  'preparing-request-read', 'preparation-fairness-write', 'preparation-framework-minimum-read', 'qualification-targets-read']) {
  test(`delivery timeout records its active ${failedPhase} without source or query payloads`, async () => {
    const reqId = randomUUID(), records: {fields: Record<string, unknown>; message: string}[] = [];
    let now = 0;
    const failure = () => {now = 21; throw Object.assign(new Error('sensitive synthetic source body'), {name: 'MongoOperationTimeoutError'});};
    const unused = async (): Promise<never> => {throw new Error('unexpected mutation');};
    const repository: TestRequestRepository = {
      insert: unused, get: unused, accept: unused, reject: unused, cancel: unused, acknowledgeCancellation: unused, cancellations: unused,
      async queued() {if (failedPhase === 'queued-request-read') failure(); return [];},
      async pendingDispatchCompletions() {if (failedPhase === 'unfinished-dispatch-completions-read') failure(); return [];},
      async preparations(_host, _limit, _version, onPhase) {
        if (failedPhase === 'preparing-request-read') failure();
        if (failedPhase === 'preparation-fairness-write') {onPhase?.('preparation-fairness-write', 2); failure();}
        return [];
      },
      async preparationFrameworkMinimum() {if (failedPhase === 'preparation-framework-minimum-read') failure(); return null;},
    };
    const service = new TestRequestService(repository, undefined, null,
      {async frameworkObservation() {if (failedPhase === 'accepted-framework-observation-read') failure(); return null;}});
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const restores: (() => void)[] = [];
    const app = new Hono<AppEnv>(); app.use('*', requestContext);
    app.use('*', async (c, next) => {
      const info = spyOn(c.var.logger, 'info').mockImplementation((() => {}) as any);
      const error = spyOn(c.var.logger, 'error').mockImplementation(((fields: Record<string, unknown>, message: string) => {records.push({fields, message});}) as any);
      restores.push(() => {info.mockRestore(); error.mockRestore();}); await next();
    });
    app.route('/', createTestRequestsApi(service, () => JSON.stringify({mini: credential}), undefined, undefined,
      {async qualificationTargets() {if (failedPhase === 'qualification-targets-read') failure(); return [];}}));
    try {
      const response = await app.request('/?preparationFrameworkMinimum=1&qualificationTargets=1',
        {headers: {...headers, 'x-request-id': reqId}});
      expect(response.status).toBe(503);
      expect(response.headers.get('x-request-id')).toBe(reqId);
      expect(await response.json()).toEqual({error: 'request_delivery_unavailable'});
      const record = records.find(value => value.message === 'controller request delivery phase failed');
      expect(record?.fields).toMatchObject({phase: failedPhase, hostId: 'mini', reqId, errorName: 'MongoOperationTimeoutError',
        qualificationMode: 'discovery', minimumRequested: true, stageElapsedMs: 21, requestElapsedMs: 21});
      expect(JSON.stringify(records)).not.toContain('sensitive synthetic source body');
      expect(record?.fields).not.toHaveProperty('query');
      if (failedPhase === 'preparation-fairness-write') expect(record?.fields.rowCount).toBe(2);
    } finally {restores.forEach(restore => restore()); clock.mockRestore();}
  });
}

test('pending delivery reports the active read before the client deadline and clears its warning', async () => {
  const reqId = randomUUID(), warnings: unknown[] = [];
  let now = 0, alarm: (() => void) | undefined, cleared = false;
  let finish: (value: []) => void = () => {}, notifyStarted: () => void = () => {};
  const answer = new Promise<[]>(resolve => {finish = resolve;});
  const started = new Promise<void>(resolve => {notifyStarted = resolve;});
  const unused = async (): Promise<never> => {throw new Error('unexpected mutation');};
  const repository: TestRequestRepository = {insert: unused, get: unused, accept: unused, reject: unused, cancel: unused,
    acknowledgeCancellation: unused, cancellations: unused, async queued() {notifyStarted(); return answer;}};
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(10000); alarm = callback; return 1;
  }) as any);
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation((() => {cleared = true;}) as any);
  const restores: (() => void)[] = [];
  const app = new Hono<AppEnv>(); app.use('*', requestContext);
  app.use('*', async (c, next) => {
    expect(c.var.logger.bindings().reqId).toBe(reqId);
    const info = spyOn(c.var.logger, 'info').mockImplementation((() => {}) as any);
    const warn = spyOn(c.var.logger, 'warn').mockImplementation(((fields: unknown) => {warnings.push(fields);}) as any);
    restores.push(() => {info.mockRestore(); warn.mockRestore();}); await next();
  });
  app.route('/', createTestRequestsApi(new TestRequestService(repository), () => JSON.stringify({mini: credential})));
  const pending = app.request('/', {headers: {...headers, 'x-request-id': reqId}});
  try {
    await started; now = 10000; alarm?.();
    expect(warnings).toEqual([expect.objectContaining({phase: 'queued-request-read', reqId, hostId: 'mini',
      qualificationMode: 'none', minimumRequested: false, stageElapsedMs: 10000, requestElapsedMs: 10000})]);
    expect(cleared).toBe(false); now = 11000; finish([]);
    expect((await pending).status).toBe(200); expect(cleared).toBe(true);
  } finally {
    finish([]); await pending; restores.forEach(restore => restore()); clock.mockRestore(); timer.mockRestore(); cancel.mockRestore();
  }
});
