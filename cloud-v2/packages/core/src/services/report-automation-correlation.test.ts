import {afterEach, expect, spyOn, test} from 'bun:test';
import {ReportModel} from '../models/report.model';
import {findDeviceIncidentReport, submitReport} from './report.service';

afterEach(() => {for (const mock of mocks.splice(0)) mock.mockRestore();});
const mocks: Array<{mockRestore(): void}> = [];
const correlation = {alertId: 'exact-alert', testRunId: 'exact-run'};
const input = {mentraUserId: 'authenticated-owner', kind: 'automatic' as const, automationCorrelation: correlation,
  trigger: {type: 'automatic' as const, source: 'mentra_automated_testing', reason: 'incident_report_requested'},
  report: {actualBehavior: 'Original failure'}, context: {}};

test('report creation persists correlation atomically with the authenticated device report', async () => {
  let created: Record<string, unknown> | undefined;
  mocks.push(spyOn(ReportModel, 'create').mockImplementation((async (value: Record<string, unknown>) => {
    created = value; return value;
  }) as never));
  const result = await submitReport(input);
  expect(created).toMatchObject({reportId: result.reportId, mentraUserId: 'authenticated-owner', automationCorrelation: correlation});
  expect(result.status).toBe('collecting');
  expect(created?.logCollection).toBeDefined();
  for (const changed of [{automationCorrelation: {...correlation, alertId: '../foreign'}},
    {trigger: {...input.trigger, source: 'unrelated-source'}}, {trigger: {...input.trigger, reason: 'unrelated-reason'}}])
    await expect(submitReport({...input, ...changed})).rejects.toThrow('Invalid automated incident correlation');
});

test('exact lookup keeps failed collection reports linkable and rejects duplicates or unrelated reports', async () => {
  let rows: unknown[] = [], filter: unknown, limit: unknown;
  mocks.push(spyOn(ReportModel, 'find').mockImplementation(((value: unknown) => {
    filter = value;
    const query = {select() {return query;}, limit(value: unknown) {limit = value; return query;},
      read() {return query;}, readConcern() {return query;}, setOptions() {return query;}, async lean() {return rows;}};
    return query;
  }) as never));
  const original = {reportId: 'rep_ORIGINAL', kind: 'automatic', trigger: input.trigger,
    logCollection: {glasses: {state: 'failed'}}};
  rows = [original];
  expect(await findDeviceIncidentReport(correlation)).toBe('rep_ORIGINAL');
  expect(filter).toEqual({'automationCorrelation.testRunId': 'exact-run', 'automationCorrelation.alertId': 'exact-alert'});
  expect(limit).toBe(2);
  for (const candidates of [[], [original, {...original, reportId: 'rep_COLLISION', mentraUserId: 'another-account'}],
    [{...original, kind: 'bug'}], [{...original, trigger: {...input.trigger, source: 'unrelated'}}],
    [{...original, trigger: {...input.trigger, reason: 'different'}}], [{...original, reportId: '../foreign'}]]) {
    rows = candidates;
    expect(await findDeviceIncidentReport(correlation)).toBeNull();
  }
});
