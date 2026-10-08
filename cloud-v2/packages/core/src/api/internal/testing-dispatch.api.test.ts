import {expect, test} from 'bun:test';
import {Hono} from 'hono';
import {createTestingDispatchApi} from './testing-dispatch.api';

test('only an enrolled host can refresh the expiring runner credential', async () => {
  const token = 'enrolled-' + 'a'.repeat(40), receipt = {credential: 'short-lived-installation-token', expiresAt: '2026-10-08T07:00:00.000Z'};
  let calls = 0;
  const app = new Hono();
  app.route('/api/internal/testing/dispatch', createTestingDispatchApi({async runnerCredential() {calls++; return receipt;}},
    () => JSON.stringify({mini: token})));
  const path = '/api/internal/testing/dispatch/runner-token';
  for (const authorization of [undefined, 'Bearer observer-token', 'Bearer foreign']) {
    const response = await app.request(path, {method: 'POST', headers: authorization ? {authorization} : {}});
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(calls).toBe(0);
  const response = await app.request(path, {method: 'POST', headers: {authorization: `Bearer ${token}`},
    body: JSON.stringify({hostId: 'other', repositories: ['unrelated'], permissions: {contents: 'write'}})});
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(receipt);
  expect(calls).toBe(1);
});

test('runner credential failures never expose provider response or App credentials', async () => {
  const token = 'b'.repeat(40), app = createTestingDispatchApi({async runnerCredential() {throw new Error('private-key provider-body token');}},
    () => JSON.stringify({mini: token}));
  const response = await app.request('/runner-token', {method: 'POST', headers: {authorization: `Bearer ${token}`}});
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error: 'runner_credential_unavailable'});
  expect(response.headers.get('cache-control')).toBe('no-store');
});
