import {describe, expect, test} from 'bun:test';

import {initialReportLogCollection, isReportLogSource, REPORT_LOG_DEADLINE_MS, REPORT_LOG_SOURCES, visibleReportLogCollection} from './report-log-collection';

const NOW = new Date('2026-10-09T16:30:00.123Z');

describe('per-source report log collection receipts', () => {
  test('declares all expected sources with one frozen report deadline and independent rows', () => {
    const rows = initialReportLogCollection(NOW);
    expect(Object.keys(rows)).toEqual(['phone', 'glasses', 'glasses_firmware', 'cloud', 'miniapp_server']);
    for (const source of REPORT_LOG_SOURCES) {
      expect(rows[source]).toEqual({
        state: 'requested', requestedAt: NOW.toISOString(),
        deadlineAt: new Date(NOW.getTime() + REPORT_LOG_DEADLINE_MS).toISOString(),
      });
    }
    rows.phone.reason = 'local reason';
    expect(rows.glasses.reason).toBeUndefined();
    expect(isReportLogSource('phone_delivery')).toBe(false);
    expect(isReportLogSource('arbitrary_backend')).toBe(false);
    expect(isReportLogSource('miniapp_server')).toBe(true);
  });

  test('derives timeout only at the original deadline and leaves the durable request unchanged', () => {
    const rows = initialReportLogCollection(NOW);
    rows.glasses.reason = 'local_sdk_dispatch_completed';
    const deadline = NOW.getTime() + REPORT_LOG_DEADLINE_MS;
    expect(visibleReportLogCollection(rows, deadline - 1).glasses?.state).toBe('requested');
    expect(visibleReportLogCollection(rows, deadline).glasses).toMatchObject({
      state: 'timed-out', reason: 'No log artifact arrived before the collection deadline',
      requestedAt: NOW.toISOString(), deadlineAt: new Date(deadline).toISOString(),
    });
    expect(rows.glasses.state).toBe('requested');
    expect(rows.glasses.reason).toBe('local_sdk_dispatch_completed');
  });

  test('preserves actual receipt even after its deadline and exposes zero received entries accurately', () => {
    const rows = initialReportLogCollection(NOW);
    rows.phone = {...rows.phone, state: 'received', receivedAt: NOW.toISOString(), artifactId: 'art_phone', entryCount: 0};
    const visible = visibleReportLogCollection(rows, NOW.getTime() + REPORT_LOG_DEADLINE_MS + 1);
    expect(visible.phone).toEqual(rows.phone);
    expect(visible.glasses?.state).toBe('timed-out');
  });

  test('keeps precise failed and unavailable outcomes after the collection deadline', () => {
    const rows = initialReportLogCollection(NOW);
    rows.glasses = {...rows.glasses, state: 'failed', reason: 'incident_dispatch_timeout'};
    rows.glasses_firmware = {...rows.glasses_firmware, state: 'unavailable', reason: 'glasses_disconnected'};
    const visible = visibleReportLogCollection(rows, NOW.getTime() + REPORT_LOG_DEADLINE_MS + 1);
    expect(visible.glasses).toEqual(rows.glasses);
    expect(visible.glasses_firmware).toEqual(rows.glasses_firmware);
  });

  test('does not invent source receipt for an absent original collection record', () => {
    expect(visibleReportLogCollection(undefined, NOW.getTime())).toEqual({});
    expect(visibleReportLogCollection({}, NOW.getTime())).toEqual({});
  });
});
