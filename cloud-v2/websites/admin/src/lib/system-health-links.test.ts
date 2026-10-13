import {expect, test} from 'bun:test';
import {readSystemHealthTab, systemHealthLocation} from './system-health-links';

test('health section URLs preserve repair deep links and reject unknown or ambiguous tabs', () => {
  expect(readSystemHealthTab('?systemHealth=1&healthTab=memory')).toBe('memory');
  expect(readSystemHealthTab('?systemHealth=1&restoration=1')).toBe('repair');
  for (const search of ['', '?healthTab=memory', '?systemHealth=1&healthTab=other', '?systemHealth=1&healthTab=memory&healthTab=disk']) {
    expect(readSystemHealthTab(search)).toBe('lanes');
  }
});
test('changing sections spends lane detail scope while keeping the system health location', () => {
  const href = 'https://admin.dev.mentraglass.com/?systemHealth=1&hostId=air&laneId=android&restoration=1#lane-air-android';
  expect(systemHealthLocation(href, 'framework')).toBe('/?systemHealth=1&healthTab=framework');
  expect(systemHealthLocation(href, 'lanes')).toBe('/?systemHealth=1');
  expect(readSystemHealthTab(systemHealthLocation(href, 'pending').split('?')[1]!)).toBe('pending');
});
