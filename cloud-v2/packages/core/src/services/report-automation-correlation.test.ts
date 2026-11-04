import {afterEach, expect, spyOn, test} from 'bun:test';
import {ReportModel} from '../models/report.model';
import {submitReport} from './report.service';

afterEach(() => {for (const mock of mocks.splice(0)) mock.mockRestore();});
const mocks: Array<{mockRestore(): void}> = [];
const correlation = {alertId: 'exact-alert', testRunId: 'exact-run'};
const input = {mentraUserId: 'authenticated-owner', kind: 'automatic' as const, automationCorrelation: correlation,
  trigger: {type: 'automatic' as const, source: 'mentra_automated_testing', reason: 'incident_report_requested'},
  report: {actualBehavior: 'Original failure'}, context: {}};

test('report creation persists correlation atomically with the authenticated device report', async () => {
  let created: Record<string, unknown> | undefined, options: unknown;
  mocks.push(spyOn(ReportModel, 'create').mockImplementation((async (value: Array<Record<string, unknown>>, configuration: unknown) => {
    expect(value).toHaveLength(1); created = value[0]; options = configuration; return value;
  }) as never));
  const result = await submitReport(input);
  expect(created).toMatchObject({reportId: result.reportId, mentraUserId: 'authenticated-owner', automationCorrelation: correlation});
  expect(result.status).toBe('collecting');
  expect(created?.logCollection).toBeDefined();
  expect(options).toEqual({writeConcern: {w: 'majority', j: true, wtimeout: 10_000}});
  for (const changed of [{automationCorrelation: {...correlation, alertId: '../foreign'}},
    {trigger: {...input.trigger, source: 'unrelated-source'}}, {trigger: {...input.trigger, reason: 'unrelated-reason'}}])
    await expect(submitReport({...input, ...changed})).rejects.toThrow('Invalid automated incident correlation');
});
