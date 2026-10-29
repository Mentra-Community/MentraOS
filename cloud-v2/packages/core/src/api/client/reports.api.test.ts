import {afterEach, expect, spyOn, test} from 'bun:test';
import {Hono} from 'hono';
import reportsApi from './reports.api';
import type {AppEnv} from '../../types/hono.types';
import {OauthError} from '../../types/oauth.types';
import * as session from '../../services/session.service';
import * as reporting from '../../services/report.service';

const mocks: Array<{mockRestore(): void}> = [];
afterEach(() => {for (const mock of mocks.splice(0)) mock.mockRestore();});

test('authenticated submission accepts one typed correlation only for automation incidents', async () => {
  mocks.push(spyOn(session, 'verifyAccessToken').mockResolvedValue({mentraUserId: 'mu_TEST', tenantId: 'mentra',
    sessionId: 'session', jti: 'jti', exp: Math.floor(Date.now() / 1000) + 100} as never));
  const submitted: unknown[] = [];
  mocks.push(spyOn(reporting, 'submitReport').mockImplementation(async input => {
    submitted.push(input); return {reportId: 'rep_ORIGINAL', status: 'collecting'};
  }));
  const app = new Hono<AppEnv>().route('/', reportsApi);
  app.onError((error, c) => error instanceof OauthError ? c.json({error: error.code}, error.httpStatus as 400)
    : c.json({error: 'server_error'}, 500));
  const body = {kind: 'automatic', trigger: {type: 'automatic', source: 'mentra_automated_testing', reason: 'incident_report_requested'},
    report: {actualBehavior: 'Original failure'}, context: {}, automationCorrelation: {alertId: 'exact-alert', testRunId: 'exact-run'}};
  const call = (input: unknown) => app.request('/', {method: 'POST', headers: {Authorization: 'Bearer synthetic',
    'Content-Type': 'application/json'}, body: JSON.stringify(input)});
  expect((await call(body)).status).toBe(200);
  expect(submitted).toEqual([{...body, mentraUserId: 'mu_TEST'}]);
  for (const changed of [{automationCorrelation: null}, {automationCorrelation: {...body.automationCorrelation, extra: 'private'}},
    {automationCorrelation: {...body.automationCorrelation, testRunId: ' '}},
    {trigger: {...body.trigger, source: 'other'}}, {kind: 'bug', trigger: {...body.trigger, type: 'manual'}},
    {kind: 'feedback', feedback: 'Feature request'}]) expect((await call({...body, ...changed})).status).toBe(400);
  expect(submitted).toHaveLength(1);
});
