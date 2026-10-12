import {expect, test} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {SYSTEM_HEALTH_TABS} from '../lib/system-health-links';
import {SystemHealthPage} from './system-health';

const now = new Date().toISOString();
function client() {
  const query = new QueryClient({defaultOptions: {queries: {retry: false}}});
  query.setQueryData(['test-host-health'], {hosts: [{schemaVersion: 1, hostId: 'air', sampleId: 'sample', sampledAt: now, receivedAt: now,
    freeBytes: 20 * 1024 ** 3, components: [], cleanupEvents: []}]});
  query.setQueryData(['lane-overview'], {hosts: [], freshForMs: 120_000});
  return query;
}

test('system health has seven accessible tabs with only the selected panel content mounted', () => {
  for (const tab of SYSTEM_HEALTH_TABS) {
    const query = client();
    const html = renderToStaticMarkup(<QueryClientProvider client={query}><SystemHealthPage tab={tab.id} /></QueryClientProvider>);
    const buttons = html.match(/<button[^>]*role="tab"[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(7);
    expect(buttons.map(button => button.match(/>([^<]*)<\/button>/)?.[1])).toEqual(SYSTEM_HEALTH_TABS.map(row => row.label.replace('&', '&amp;')));
    const active = buttons[SYSTEM_HEALTH_TABS.findIndex(row => row.id === tab.id)]!;
    expect(active).toContain('aria-selected="true"');
    expect(active).toContain('tabindex="0"');
    const panels = html.match(/<div[^>]*role="tabpanel"[^>]*>/g) ?? [];
    expect(panels).toHaveLength(7);
    const selectedPanel = panels.find(panel => !panel.includes('hidden=""'))!;
    expect(selectedPanel).toContain(`id="${active.match(/aria-controls="([^"]*)"/)?.[1]}"`);
    buttons.forEach(button => expect(panels.some(panel => panel.includes(`id="${button.match(/aria-controls="([^"]*)"/)?.[1]}"`))).toBe(true));
    expect(buttons.filter(button => button.includes('aria-selected="false"')).every(button => button.includes('tabindex="-1"'))).toBe(true);
    const keys = query.getQueryCache().getAll().map(row => row.queryKey[0]);
    expect(keys.includes('test-pending-queue')).toBe(tab.id === 'pending');
    expect(keys.includes('lane-restoration')).toBe(tab.id === 'repair');
    expect(keys.includes('test-host-history')).toBe(['memory', 'disk'].includes(tab.id));
    if (tab.id === 'framework') {
      expect(html).toContain('No controller framework report');
      expect(html).not.toContain('Device lanes');
    }
    query.clear();
  }
});

test('a lane deep link stays in Lanes and inactive fleet sections do not mount', () => {
  const query = client();
  const html = renderToStaticMarkup(<QueryClientProvider client={query}>
    <SystemHealthPage tab="pending" lane={{hostId: 'air', laneId: 'android'}} />
  </QueryClientProvider>);
  expect(html).toContain('role="tab" aria-selected="true"');
  expect(html).toContain('android history');
  expect(query.getQueryCache().find({queryKey: ['test-pending-queue', undefined]})).toBeUndefined();
  expect(query.getQueryCache().find({queryKey: ['test-host-history', 'air', 1]})).toBeUndefined();
  query.clear();
});

test('default lanes do not create host, pending, framework-history or repair queries', () => {
  const query = new QueryClient({defaultOptions: {queries: {retry: false}}});
  renderToStaticMarkup(<QueryClientProvider client={query}><SystemHealthPage /></QueryClientProvider>);
  expect(query.getQueryCache().getAll().map(row => row.queryKey)).toEqual([['lane-overview']]);
  query.clear();
});
