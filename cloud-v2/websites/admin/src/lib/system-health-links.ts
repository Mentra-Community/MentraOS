export const SYSTEM_HEALTH_TABS = [
  {id: 'lanes', label: 'Lanes'},
  {id: 'pending', label: 'Pending queue'},
  {id: 'framework', label: 'Framework'},
  {id: 'services', label: 'Services'},
  {id: 'memory', label: 'Memory'},
  {id: 'disk', label: 'Disk & cleanup'},
  {id: 'repair', label: 'State repair'},
] as const;
export type SystemHealthTab = typeof SYSTEM_HEALTH_TABS[number]['id'];

export function readSystemHealthTab(search: string): SystemHealthTab {
  const query = new URLSearchParams(search);
  if (query.get('systemHealth') !== '1') return 'lanes';
  if (!query.has('healthTab') && query.get('restoration') === '1') return 'repair';
  const value = query.getAll('healthTab');
  return value.length === 1 ? SYSTEM_HEALTH_TABS.find(tab => tab.id === value[0])?.id ?? 'lanes' : 'lanes';
}

export function systemHealthLocation(href: string, tab: SystemHealthTab): string {
  const url = new URL(href);
  url.searchParams.set('systemHealth', '1');
  for (const key of ['healthTab', 'restoration', 'hostId', 'laneId']) url.searchParams.delete(key);
  if (tab !== 'lanes') url.searchParams.set('healthTab', tab);
  url.hash = '';
  return url.pathname + url.search;
}
