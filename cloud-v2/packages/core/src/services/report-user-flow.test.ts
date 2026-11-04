import {afterEach, beforeEach, expect, spyOn, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {ReportAssetModel} from '../models/report-asset.model';
import {ReportNativeRunModel} from '../models/report-native-run.model';
import {ReportModel} from '../models/report.model';
import {UserModel} from '../models/user.model';
import {getReport, listReports, markReportReady, submitReport} from './report.service';

const mocks: Array<{mockRestore(): void}> = [];
const slackEnvironment = {CLOUD_REPORTS_SLACK_BOT_TOKEN: 'synthetic-token', CLOUD_REPORTS_SLACK_CHANNEL_ID: 'C-REPORTS'};
const previous = Object.keys(slackEnvironment).map(key => [key, process.env[key]] as const);
beforeEach(() => {
  Object.assign(process.env, slackEnvironment);
});
afterEach(() => {
  mocks.splice(0).forEach(mock => mock.mockRestore());
  // Variable by variable: replacing process.env itself would stop Bun following TZ for every later test file.
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const bug = {mentraUserId: 'mu_user', kind: 'bug' as const,
  trigger: {type: 'manual' as const, source: 'mentra_app', reason: 'manual_bug_report'},
  report: {actualBehavior: 'Captions stopped', expectedBehavior: 'Captions keep going', userSeverity: 3 as const},
  context: {appVersion: '2.1.0'}};

function slackPosts() {
  const posts: Array<{url: string; body: Record<string, unknown>}> = [];
  mocks.push(spyOn(UserModel, 'findOne').mockImplementation((() => ({lean: async () => null})) as never));
  mocks.push(spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    posts.push({url: String(url), body: JSON.parse(String(init.body))});
    return Response.json({ok: true, channel: 'C-REPORTS', ts: '1.0'});
  }) as never));
  return posts;
}
const settle = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5));
};

test('a user bug report is stored, then posted to Slack once when collection finishes', async () => {
  const posts = slackPosts();
  let created: Record<string, unknown> | undefined;
  mocks.push(spyOn(ReportModel, 'create').mockImplementation((async (value: Record<string, unknown>) => {created = value; return value;}) as never));
  const submitted = await submitReport(bug);
  expect(submitted.status).toBe('collecting');
  expect(submitted.reportId).toMatch(/^rep_/);
  expect(created).toMatchObject({mentraUserId: 'mu_user', kind: 'bug', trigger: bug.trigger, report: bug.report, context: bug.context,
    artifacts: [], status: 'collecting'});
  expect(created?.logCollection).toBeDefined();
  // Nothing automated-testing is ever written on a user's report.
  expect(created).not.toHaveProperty('automationCorrelation');
  expect(created).not.toHaveProperty('nativeDiagnostics');
  expect(created).not.toHaveProperty('slackDelivery');
  expect(posts).toEqual([]);

  const before = {reportId: submitted.reportId, mentraUserId: 'mu_user', kind: 'bug', status: 'collecting',
    trigger: bug.trigger, report: bug.report, feedback: null, context: bug.context, artifacts: [{artifactId: 'art_1'}]};
  mocks.push(spyOn(ReportModel, 'findOneAndUpdate').mockImplementationOnce((() => ({lean: async () => before})) as never));
  expect(await markReportReady({mentraUserId: 'mu_user', reportId: submitted.reportId})).toBe('ready');
  await settle(() => posts.length > 0);
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toBe('https://slack.com/api/chat.postMessage');
  expect(posts[0]?.body.channel).toBe('C-REPORTS');
  expect(JSON.stringify(posts[0]?.body)).toContain('Captions stopped');
});

test('feedback is ready at once and posts without a collection step', async () => {
  const posts = slackPosts();
  mocks.push(spyOn(ReportModel, 'create').mockImplementation((async (value: unknown) => value) as never));
  const submitted = await submitReport({mentraUserId: 'mu_user', kind: 'feedback', feedback: 'More controls', context: {}});
  expect(submitted.status).toBe('ready');
  await settle(() => posts.length > 0);
  expect(posts[0]?.body.channel).toBe('C-REPORTS');
});

test('triage reads a user report and its uploads without touching old test runs', async () => {
  const createdAt = new Date('2026-11-01T10:00:00Z');
  const row = {reportId: 'rep_USER', kind: 'bug', status: 'ready', mentraUserId: 'mu_user', trigger: bug.trigger, report: bug.report,
    feedback: null, context: bug.context, createdAt, updatedAt: createdAt,
    artifacts: [{artifactId: 'art_LOG', type: 'logs', source: 'phone', filename: null, contentType: 'application/json', sizeBytes: 12, createdAt}]};
  const asset = {artifactId: 'art_LOG', reportId: 'rep_USER', storageKey: 'reports/rep_USER/art_LOG', fileName: null,
    contentType: 'application/json', sizeBytes: 12, sha256: 'd'.repeat(64), createdAt};
  mocks.push(spyOn(ReportModel, 'findOne').mockImplementation((() => ({lean: async () => row})) as never));
  mocks.push(spyOn(ReportAssetModel, 'find').mockImplementation((() => ({sort: () => ({lean: async () => [asset]})})) as never));
  const run = spyOn(ReportNativeRunModel, 'findOne');
  mocks.push(run);
  const detail = await getReport('rep_USER');
  expect(detail?.report).toMatchObject({reportId: 'rep_USER', kind: 'bug', mentraUserId: 'mu_user', context: bug.context});
  expect(detail?.report.artifacts.map(item => item.artifactId)).toEqual(['art_LOG']);
  expect(detail?.assets.map(item => item.storageKey)).toEqual(['reports/rep_USER/art_LOG']);
  expect(run).not.toHaveBeenCalled();

  mocks.push(spyOn(ReportModel, 'aggregate').mockImplementation((async () => [{...row, artifactCount: 1}]) as never));
  expect((await listReports({kind: 'bug'}))[0]).toMatchObject({reportId: 'rep_USER', artifactCount: 1});
});

/** What reports run on, followed through every local import. The test-run read is the one named exception. */
test('the report code imports nothing of the old device-testing system', () => {
  const root = join(import.meta.dir, '..');
  const transpiler = new Bun.Transpiler({loader: 'ts'});
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const {path} of transpiler.scanImports(readFileSync(file, 'utf8')))
      if (path.startsWith('.')) visit(join(dirname(file), path.endsWith('.ts') ? path : `${path}.ts`));
  };
  for (const entry of ['services/report.service.ts', 'services/report-reconciliation.ts', 'api/client/reports.api.ts', 'api/admin/reports.api.ts', 'api/agent/reports.api.ts'])
    visit(join(root, entry));
  const testing = /(^|\/)(test-|testing|routine-|framework-|nightly|lane-|resource-|backend-|candidate-|failed-framework)/;
  expect([...seen].map(file => relative(root, file)).filter(file => testing.test(file))).toEqual([]);
});
