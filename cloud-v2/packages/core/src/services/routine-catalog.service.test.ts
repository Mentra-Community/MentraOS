import {expect, spyOn, test} from "bun:test";
import {TestRunModel} from '../models/test-run.model';
import {RoutineCatalogService} from "./routine-catalog.service";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import type {CatalogExample, CatalogHistoryRun} from "../types/test-history.types";
import type {RoutinePreference, RoutinePreferenceRepository} from "./routine-preference.service";
import {recordedFrameworkRunSchema} from '../types/framework-run.types';
import {createRecordedFrameworkRunSummaryProjection} from './framework-run-summary.service';
import {requestInputDigest} from './test-request.service';

const preferences = {async list() {return [];}, async get() {return null;}, async set() {}};
const example: CatalogExample = {runId: "notes-pass", startedAt: "2026-10-02T18:00:00Z",
  finishedAt: "2026-10-02T18:01:00Z", recordingAssetId: "video", definitionRevision: "a".repeat(40),
  build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}};
test('public passing selector excludes verification candidates while retaining prior ordinary examples', async () => {
  const find = spyOn(TestRunModel, 'findOne').mockReturnValue({sort() {return this;}, select() {return this;},
    read() {return this;}, readConcern() {return this;}, lean: async () => null} as unknown as ReturnType<typeof TestRunModel.findOne>);
  const definition = {routineId: 'notes', platform: 'android', definitionRevision: 'c'.repeat(40)} as RoutineEnrollment;
  try {
    const service = new RoutineCatalogService({async current() {return [definition];}, async overview() {return this.current();}, async getCurrent() {return definition;}},
      undefined, preferences);
    // A history read is separate from eligibility; isolate this selector via a detail with mocked history.
    const history = spyOn(TestRunModel, 'find').mockReturnValue({sort() {return this;}, limit() {return this;}, select() {return this;},
      read() {return this;}, readConcern() {return this;}, lean: async () => []} as unknown as ReturnType<typeof TestRunModel.find>);
    try {expect(await service.list()).toEqual([]);} finally {history.mockRestore();}
    expect(find.mock.calls[0]?.[0]).toMatchObject({routineId: 'notes', platform: 'android', catalogEligible: {$ne: false}});
  } finally {find.mockRestore();}
});
test("a historical passing example retains catalog membership while new authoring work stays out", async () => {
  const definitions = [{routineId: "notes", platform: "ios-on-mac", definitionRevision: "c".repeat(40)},
    {routineId: "gallery-sync", platform: "android", definitionRevision: "d".repeat(40)}] as RoutineEnrollment[];
  const service = new RoutineCatalogService({async current() {return definitions;}, async overview() {return this.current();}, async getCurrent() {return definitions[0]!;}}, {
    async history() {return [];}, async latestPassing(row) {return row.routineId === "notes" ? example : null;},
  }, preferences);
  const catalog = await service.list();
  expect(catalog).toHaveLength(1);
  expect(catalog[0]!.routineId).toBe("notes");
  expect(catalog[0]!.definitionRevision).toBe("c".repeat(40));
  expect(catalog[0]!.example).toEqual(example);
  expect((await service.detail("notes", "ios-on-mac")).example?.definitionRevision).toBe("a".repeat(40));
});

test('canonical catalog reads recorded payload and summary with genuinely absent provenance', async () => {
  const old = recordedFrameworkRunSchema.parse({schemaVersion: 1, requestId: 'historical-recording', hostId: 'mini', routineId: 'notes',
    definitionRevision: 'a'.repeat(40), platform: 'ios-on-mac', laneId: 'mac', build: example.build,
    startedAt: example.startedAt, finishedAt: example.finishedAt, recordingAssetId: 'video',
    assets: [{id: 'video', kind: 'recording', path: 'recording.mp4', sha256: 'c'.repeat(64), size: 100, mimeType: 'video/mp4'}],
    result: {runId: 'historical-recording', finishedAt: example.finishedAt, setup: {status: 'passed'}, test: 'passed',
      steps: [{id: 'observe', status: 'passed', durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: ['video'], timing: {startedAt: example.startedAt, setupMs: 0, testMs: 1, teardownMs: 0}}});
  const payloadSha256 = requestInputDigest(old), projection = createRecordedFrameworkRunSummaryProjection(old, payloadSha256);
  const row = {runId: old.requestId, requestId: old.requestId, payloadSha256, payload: old, summaryProjection: projection, uploadsComplete: true};
  const before = JSON.stringify(row);
  const find = spyOn(TestRunModel, 'findOne').mockReturnValue({sort() {return this;}, select() {return this;}, read() {return this;},
    readConcern() {return this;}, async lean() {return row;}} as never);
  const history = spyOn(TestRunModel, 'find').mockReturnValue({sort() {return this;}, limit() {return this;}, select() {return this;}, read() {return this;},
    readConcern() {return this;}, async lean() {return [row];}} as never);
  const definition = {routineId: 'notes', platform: 'ios-on-mac', definitionRevision: 'd'.repeat(40)} as RoutineEnrollment;
  try {
    const service = new RoutineCatalogService({async current() {return [definition];}, async overview() {return this.current();}, async getCurrent() {return definition;}}, undefined, preferences);
    const catalog = await service.list(), detail = await service.detail('notes', 'ios-on-mac');
    expect(catalog).toHaveLength(1);
    expect(detail.example?.runId).toBe(old.requestId);
    expect(detail.history[0]?.outcome).toBe('pass');
    expect(JSON.stringify(row)).toBe(before);
    expect(requestInputDigest(old)).toBe(payloadSha256);
    expect(row.summaryProjection.summarySha256).toBe(projection.summarySha256);
  } finally {find.mockRestore(); history.mockRestore();}
});

test("history pagination preserves equal-time and earlier runs and refuses foreign/malformed cursors", async () => {
  const definition = {routineId: "notes", platform: "ios-on-mac", definitionRevision: "c".repeat(40)} as RoutineEnrollment;
  const rows: CatalogHistoryRun[] = ["c", "b", "a"].map(runId => ({runId, startedAt: "2026-10-02T19:00:00Z",
    outcome: "failed", uploadsComplete: true, evidenceStatus: "complete", definitionRevision: "a".repeat(40)}));
  rows.push({...rows[0]!, runId: "z", startedAt: "2026-10-02T18:00:00Z"});
  const service = new RoutineCatalogService({async current() {return [definition];}, async overview() {return this.current();},
    async getCurrent(id) {return ["notes", "other"].includes(id) ? {...definition, routineId: id} : null;}}, {
    async latestPassing() {return null;},
    async history(_id, _platform, after, limit) {return rows.filter(row => !after
      || Date.parse(row.startedAt) < after.startedAt.getTime()
      || Date.parse(row.startedAt) === after.startedAt.getTime() && row.runId < after.runId).slice(0, limit);},
  }, preferences);
  const first = await service.detail("notes", "ios-on-mac", undefined, 2);
  expect(first.history.map(row => row.runId)).toEqual(["c", "b"]);
  const last = await service.detail("notes", "ios-on-mac", first.nextCursor!, 2);
  expect(last.history.map(row => row.runId)).toEqual(["a", "z"]);
  expect(last.nextCursor).toBeNull();
  await expect(service.detail("notes", "android", first.nextCursor!)).rejects.toThrow("cursor");
  await expect(service.detail("other", "ios-on-mac", first.nextCursor!)).rejects.toThrow("cursor");
  await expect(service.detail("notes", "ios-on-mac", "not-json")).rejects.toThrow("cursor");
  const invalidDate = Buffer.from(JSON.stringify({routineId: "notes", platform: "ios-on-mac", runId: "b", startedAt: 2026})).toString("base64url");
  await expect(service.detail("notes", "ios-on-mac", invalidDate)).rejects.toThrow("cursor");
  await expect(service.detail("notes", "ios-on-mac", undefined, 0)).rejects.toThrow("history query");
  await expect(service.detail("missing", "android")).rejects.toThrow("not enrolled");
});

test("nightly preference survives later failure and a new definition revision for the same platform", async () => {
  let revision = "c".repeat(40);
  const saved = new Map<string, RoutinePreference>();
  const preferences: RoutinePreferenceRepository = {async list() {return [...saved.values()];},
    async get(id, platform) {return saved.get(`${id}/${platform}`) ?? null;},
    async set(row) {saved.set(`${row.routineId}/${row.platform}`, row);}};
  const definition = () => ({routineId: "new-routine", platform: "android", definitionRevision: revision}) as RoutineEnrollment;
  const service = new RoutineCatalogService({async current() {return [definition()];}, async overview() {return this.current();}, async getCurrent() {return definition();}}, {
    async latestPassing() {return example;}, async history() {return [{runId: "later-failure", startedAt: "2026-10-03T18:00:00Z", outcome: "failed", uploadsComplete: true, evidenceStatus: "complete", definitionRevision: revision}];},
  }, preferences);
  expect((await service.list())[0]!.nightlyEnabled).toBe(true);
  await service.setPreference("new-routine", "android", false);
  revision = "d".repeat(40);
  const [row] = await service.list();
  expect(row!.nightlyEnabled).toBe(false);
  expect(row!.example).toEqual(example);
  expect(row!.latestAttempt!.outcome).toBe("failed");
  expect(row!.definitionRevision).toBe(revision);
  expect((await service.detail("new-routine", "android")).nightlyEnabled).toBe(false);
  await service.setPreference("new-routine", "android", true);
  expect((await service.list())[0]!.nightlyEnabled).toBe(true);
});

test('overview retains passing proof and nightly preferences while full dispatch list uses current definitions', async () => {
  const definition = {routineId: 'notes', platform: 'android' as const, definitionRevision: 'c'.repeat(40),
    definitionSha256: 'd'.repeat(64), definition: {title: 'Notes', purpose: 'Create and find a note'}};
  let fullReads = 0, cardReads = 0;
  const definitions = {async current() {fullReads++; return [{...definition, routineSource: {commit: definition.definitionRevision},
    definition: {...definition.definition, steps: [{id: 'search'}]}}] as RoutineEnrollment[];},
    async overview() {cardReads++; return [definition] as Awaited<ReturnType<import('./routine-definition.service').RoutineDefinitionService['overview']>>;},
    async getCurrent() {return null;}};
  const latest: CatalogHistoryRun = {runId: 'latest-failed', startedAt: example.startedAt, outcome: 'failed',
    evidenceStatus: 'complete', uploadsComplete: true, definitionRevision: definition.definitionRevision};
  const service = new RoutineCatalogService(definitions, {async latestPassing() {return example;}, async history() {return [latest];}},
    {async list() {return [{routineId: 'notes', platform: 'android', nightlyEnabled: false}];}, async get() {return null;}, async set() {}});
  expect(await service.overview()).toEqual([{...definition, example, latestAttempt: latest, nightlyEnabled: false}]);
  expect(fullReads).toBe(0);
  expect(cardReads).toBe(1);
  const full = await service.list();
  expect(full[0]).toHaveProperty('routineSource');
  expect(full[0]?.definition).toHaveProperty('steps');
  expect(full[0]?.example).toEqual(example);
  expect(full[0]?.nightlyEnabled).toBe(false);
  expect(fullReads).toBe(1);
});
