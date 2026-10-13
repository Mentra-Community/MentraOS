import {afterEach, expect, spyOn, test} from 'bun:test';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {renderToStaticMarkup} from 'react-dom/server';
import {SystemHealthPage} from './system-health';
import {act, create, type ReactTestRenderer} from 'react-test-renderer';

;(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const actualNow = Date.parse('2026-10-13T01:40:00Z');
const clients: QueryClient[] = [];
afterEach(() => {clients.splice(0).forEach(client => client.clear());});

function renderFreshness(offset: number) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  clients.push(client);
  const timestamp = new Date(actualNow + offset).toISOString();
  client.setQueryData(['lane-overview'], {hosts: [{hostId: 'testing-air-2', observedAt: timestamp, receivedAt: timestamp,
    lanes: [{id: 'testing-air-2-mac', platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic'}]}], freshForMs: 120000});
  // A parent clock tick can precede a new report by ten seconds. Query consumers
  // must sample the clock when rendering that response, rather than retain it.
  const clock = spyOn(Date, 'now').mockReturnValue(actualNow);
  clock.mockReturnValueOnce(actualNow - 10000);
  try {return renderToStaticMarkup(<QueryClientProvider client={client}><SystemHealthPage /></QueryClientProvider>);}
  finally {clock.mockRestore();}
}

test('a report refreshed between clock ticks keeps the live lane status', () => {
  const html = renderFreshness(-3000);
  expect(html).toContain('Controller reporting');
  expect(html).toContain('>Idle<');
  expect(html).not.toContain('Last reported state: Idle');
});

test('fresh render sampling still refuses a genuinely future or expired report', () => {
  for (const offset of [5001, -120001]) {
    const html = renderFreshness(offset);
    expect(html).not.toContain('Controller reporting');
    expect(html).toContain('Last reported state: Idle');
  }
});


test('a query-only refresh between timer ticks keeps current lane status', async () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false, staleTime: Infinity}}});
  clients.push(client);
  const clock = spyOn(Date, 'now').mockReturnValue(actualNow - 10000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown) => Response.json({enabled: false, fresh: false, controls: []})) as typeof fetch;
  const report = (at: number) => ({hosts: [{hostId: 'testing-air-2', observedAt: new Date(at).toISOString(),
    receivedAt: new Date(at).toISOString(), lanes: [{id: 'testing-air-2-mac', platform: 'ios-on-mac',
      state: 'idle', dispatchMode: 'automatic'}]}], freshForMs: 120000});
  client.setQueryData(['lane-overview'], report(actualNow - 13000));
  let view!: ReactTestRenderer;
  try {
    await act(async () => {view = create(<QueryClientProvider client={client}><SystemHealthPage /></QueryClientProvider>);});
    clock.mockReturnValue(actualNow);
    // Only the query consumer rerenders. The parent's 15-second timer has not ticked.
    await act(async () => {
      client.setQueryData(['lane-overview'], report(actualNow - 3000));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const rendered = JSON.stringify(view.toJSON());
    expect(rendered).toContain('Controller reporting');
    expect(rendered).not.toContain('Last reported state: ');
    expect(rendered).not.toContain('Current lane status is unknown.');
  } finally {
    await act(async () => {view?.unmount();});
    globalThis.fetch = originalFetch;
    clock.mockRestore();
  }
});
