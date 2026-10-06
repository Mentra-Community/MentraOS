import {RoutineCollectionModel} from '../models/routine-collection.model';
import {RoutineDefinitionModel} from "../models/routine-definition.model";
import {testRoutineSource} from "../testing/framework-fixtures";
import type {RoutineEnrollment} from "../types/routine-definition.types";
import {expect, spyOn, test} from "bun:test";
import {RoutineDefinitionService, type RoutineDefinitionRepository} from "./routine-definition.service";
import {requestInputDigest} from "./test-request.service";
import {GithubRoutineMergeGateway} from './routine-merge-eligibility.service';
import {RoutineWorkModel} from '../models/routine-work.model';
import {authoringWorkSchema} from '../types/routine-work.types';

const revision = "a".repeat(40);
function enrollment(): RoutineEnrollment {
  const definition: RoutineEnrollment["definition"] = {id: "no-glasses", minimumRoutineApiVersion: 1, title: "App navigation", purpose: "Check app navigation",
    platforms: ["ios-on-mac"], entry: "home", account: "lane", requires: [], requirements: ["Dedicated test account"],
    fixtures: [], steps: [{id: "settings", instruction: "Open Settings", expected: "Settings is visible"}],
    source: {repository: "Mentra-Community/Mentra-Automated-Testing", revision, path: "routines/no-glasses/routine.ts"}};
  return {routineId: definition.id, platform: "ios-on-mac", definitionRevision: revision,
    definitionSha256: requestInputDigest(definition), definition, routineSource: testRoutineSource(revision)};
}

test("optional model requirements retain capability IDs without changing phone-only definitions", async () => {
  const repository: RoutineDefinitionRepository = {async enroll() {}, async current() {return [];}, async getCurrent() {return null;}, async getExact() {return null;}};
  const service = new RoutineDefinitionService(repository), original = enrollment();
  expect((await service.enroll(original)).definition).not.toHaveProperty("glasses");
  const definition: RoutineEnrollment["definition"] = {...original.definition, glasses: {models: ["mentra-live"]}, requires: ["camera"], execution: {resourceKinds: ["app", "glasses", "recorder"]}};
  expect((await service.enroll({...original, definition, definitionSha256: requestInputDigest(definition)})).definition)
    .toEqual(definition);
  for (const glasses of [{models: []}, {models: ["mentra-live", "mentra-live"]}, {models: ["Mentra Live"]},
    {models: ["mentra-live"], capabilities: ["camera"]}]) {
    const changed = {...definition, glasses};
    await expect(service.enroll({...original, definition: changed, definitionSha256: requestInputDigest(changed)})).rejects.toThrow("Invalid routine definition");
  }
  const {glasses: _glasses, ...withoutGlasses} = definition;
  for (const changed of [withoutGlasses, {...definition, execution: {...definition.execution, resourceKinds: ["app", "recorder"]}}])
    await expect(service.enroll({...original, definition: changed, definitionSha256: requestInputDigest(changed)})).rejects.toThrow("Invalid routine definition");
});

test("definition enrollment refuses changed identity or digest before storage", async () => {
  let writes = 0;
  const repository: RoutineDefinitionRepository = {async enroll() {writes++;}, async current() {return [];}, async getCurrent() {return null;}, async getExact() {return null;}};
  const service = new RoutineDefinitionService(repository);
  const row = enrollment();
  await expect(service.enroll({...row, routineId: "notes"})).rejects.toThrow("Invalid");
  await expect(service.enroll({...row, definitionSha256: "b".repeat(64)})).rejects.toThrow("digest");
  await expect(service.enroll({...row, definition: {...row.definition, steps: [...row.definition.steps, ...row.definition.steps]}}))
    .rejects.toThrow("Invalid");
  expect(writes).toBe(0);
  expect(await service.enroll(row)).toEqual(row);
  expect(writes).toBe(1);
});


test("standalone Mongo enrollment uses one immutable insert and reconciles duplicate revisions", async () => {
  const row = enrollment();
  const insert = spyOn(RoutineDefinitionModel, "create").mockRejectedValue(Object.assign(new Error("duplicate"), {code: 11000}));
  const chain = (value: unknown) => ({read() {return this;}, readConcern() {return this;}, lean: async () => value});
  const find = spyOn(RoutineDefinitionModel, "findOne").mockReturnValue(chain(row) as any);
  const transaction = spyOn(RoutineDefinitionModel.db, "transaction");
  const update = spyOn(RoutineDefinitionModel, 'updateOne').mockResolvedValue({matchedCount: 1} as any);
  try {
    expect(await new RoutineDefinitionService(undefined, undefined, null).enroll(row)).toEqual(row);
    expect(transaction).not.toHaveBeenCalled();
    expect(insert.mock.calls[0]?.[0]).toMatchObject([{...row, ordinaryEnrolledAt: expect.any(Date)}]);
    find.mockReturnValue(chain({...row, definitionSha256: "b".repeat(64)}) as any);
    await expect(new RoutineDefinitionService(undefined, undefined, null).enroll(row)).rejects.toThrow("different contents");
  } finally {insert.mockRestore(); find.mockRestore(); transaction.mockRestore(); update.mockRestore();}
});

test('concurrent candidate enrollment is bounded and settles the exact current attempt without rewriting definitions', async () => {
  const row = enrollment(), verification = {workId: 'work:new', attemptId: 2, sourceRevision: revision};
  const candidate = {...row, verification};
  let stored = {...row, candidateBindings: Array.from({length: 19}, (_, index) =>
    ({workId: `work:${index}`, attemptId: 1, sourceRevision: revision}))};
  const insert = spyOn(RoutineDefinitionModel, 'create').mockRejectedValue(Object.assign(Error('duplicate'), {code: 11000}));
  const find = spyOn(RoutineDefinitionModel, 'findOne').mockImplementation(() => ({read() {return this;}, readConcern() {return this;}, lean: async () =>
    structuredClone(stored)}) as any);
  const updates: unknown[] = [];
  const update = spyOn(RoutineDefinitionModel, 'updateOne').mockImplementation((filter: any, change?: any) => {
    updates.push({filter, change});
    if (change.$addToSet && stored.candidateBindings.length < filter.$expr.$lt[1] &&
        !stored.candidateBindings.some(value => value.workId === filter['candidateBindings.workId'].$ne))
      stored.candidateBindings.push(change.$addToSet.candidateBindings);
    if (change.$set?.['candidateBindings.$']) {
      const index = stored.candidateBindings.findIndex(value => requestInputDigest(value) === requestInputDigest(filter.candidateBindings.$elemMatch));
      if (index >= 0) stored.candidateBindings[index] = change.$set['candidateBindings.$'];
    }
    return Promise.resolve({matchedCount: 1}) as any;
  });
  try {
    const service = new RoutineDefinitionService(undefined, {async authorize() {}}, null);
    const results = await Promise.allSettled([service.enroll(candidate, 'mini'),
      service.enroll({...candidate, verification: {...verification, workId: 'work:racing'}}, 'mini')]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(stored.candidateBindings).toHaveLength(20);
    expect(stored.definitionSha256).toBe(requestInputDigest(stored.definition));
    expect(stored).not.toHaveProperty('ordinaryEnrolledAt');
    expect(updates).toHaveLength(2);
    await service.enroll(candidate, 'mini');
    expect(updates).toHaveLength(2);
    await service.enroll({...candidate, verification: {...verification, attemptId: 3}}, 'mini');
    expect(stored.candidateBindings.find(value => value.workId === verification.workId)?.attemptId).toBe(3);
    expect(stored.candidateBindings).toHaveLength(20);
    await expect(service.enroll(candidate, 'mini')).rejects.toThrow('another attempt');
  } finally {insert.mockRestore(); find.mockRestore(); update.mockRestore();}
});

test('omitting verification cannot make the same unmerged candidate SHA ordinary', async () => {
  const row = enrollment(), binding = {workId: 'work:edit', attemptId: 3, sourceRevision: revision};
  const work = authoringWorkSchema.parse({schemaVersion: 1, workId: binding.workId, kind: 'edit', routineId: row.routineId,
    brief: {goal: 'Edit navigation', stepsOrChanges: ['Open settings'], expected: ['Settings visible']},
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision}, target: {hostId: 'mini', laneId: 'ios'},
    requirements: {platform: 'mac', glasses: [], capabilities: [], environment: []},
    build: {kind: 'mac-ci-package', repository: 'Mentra-Community/MentraOS', headSha: 'b'.repeat(40), channel: 'pr', prNumber: 12,
      source: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 1},
      archive: {name: 'app.zip', url: 'https://example.com/app.zip', size: 10, sha256: 'd'.repeat(64)},
      receipt: {url: 'https://example.com/receipt.json', size: 10, sha256: 'e'.repeat(64)}}});
  const prUrl = 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/500';
  const chain = (value: unknown) => ({read() {return this;}, readConcern() {return this;}, lean: async () => value});
  const create = spyOn(RoutineDefinitionModel, 'create').mockRejectedValue(Object.assign(Error('duplicate'), {code: 11000}));
  const definitions = spyOn(RoutineDefinitionModel, 'findOne').mockReturnValue(chain({...row, candidateBindings: [binding]}) as any);
  const jobs = spyOn(RoutineWorkModel, 'findOne').mockReturnValue(chain({status: {details: {workId: binding.workId,
    hostId: 'mini', inputSha256: requestInputDigest(work), work, acceptedAt: '2026-10-05T10:00:00Z', state: 'passed',
    sequence: 4, attemptId: 3, events: [], details: {sourceRevision: revision, prUrl,
      review: {sourceRevision: revision, verdict: 'APPROVED', prUrl, reviewUrl: prUrl + '#pullrequestreview-44'}}}}}) as any);
  const update = spyOn(RoutineDefinitionModel, 'updateOne').mockResolvedValue({matchedCount: 1} as any);
  let merged = false;
  const gateway = spyOn(GithubRoutineMergeGateway.prototype, 'merged').mockImplementation(async () => merged);
  try {
    const service = new RoutineDefinitionService(undefined, undefined, null);
    await expect(service.enroll(row, 'mini')).rejects.toThrow('confirmed normal merged-source');
    expect(update).not.toHaveBeenCalled();
    merged = true;
    expect(await service.enroll(row, 'mini')).toEqual(row);
    expect((update.mock.calls as unknown[][])[0]?.[1]).toEqual({$set: {ordinaryEnrolledAt: expect.any(Date)}});
  } finally {create.mockRestore(); definitions.mockRestore(); jobs.mockRestore(); update.mockRestore(); gateway.mockRestore();}
});

test('current default selection waits for a complete published collection', async () => {
  const find = spyOn(RoutineCollectionModel, 'findOne').mockReturnValue({read() {return this;}, readConcern() {return this;}, sort() {return this;}, select() {return this;},
    lean: async () => null} as unknown as ReturnType<typeof RoutineCollectionModel.findOne>);
  try {
    const service = new RoutineDefinitionService(undefined, undefined, null);
    expect(await service.current()).toEqual([]);
    expect(await service.getCurrent('notes', 'android')).toBeNull();
    expect(find).toHaveBeenCalled();
  } finally {find.mockRestore();}
});

test("lifecycle definitions retain optional hook metadata and unique action IDs across every phase", async () => {
  const repository: RoutineDefinitionRepository = {async enroll() {}, async current() {return [];}, async getCurrent() {return null;}, async getExact() {return null;}};
  const service = new RoutineDefinitionService(repository);
  const old = enrollment();
  expect((await service.enroll(old)).definition).not.toHaveProperty("setup");
  const setup = {id: "create-fixture", instruction: "Create a fixture note", expected: "The fixture note is saved"};
  const teardown = {id: "remove-fixture", instruction: "Remove the fixture note", expected: "The fixture note is absent"};
  const submit = (definition: RoutineEnrollment["definition"]) => service.enroll({...old, definition,
    definitionSha256: requestInputDigest(definition)});
  const definition = {...old.definition, setup: [setup], teardown: [teardown]};
  expect((await submit(definition)).definition).toEqual(definition);
  expect((await submit({...old.definition, setup: [], teardown: []})).definition.setup).toEqual([]);
  for (const invalid of [
    {...definition, setup: [setup, setup]}, {...definition, teardown: [{...teardown, id: setup.id}]},
    {...definition, setup: [{...setup, id: old.definition.steps[0]!.id}]},
    {...definition, setup: [{...setup, id: "shared:install"}]},
    {...definition, setup: [{...setup, instruction: ""}]}, {...definition, setup: Array(501).fill(setup)},
  ]) await expect(submit(invalid)).rejects.toThrow("Invalid routine definition");
});

test('collection manifest freezes membership, version and rows across retries and concurrent reads', async () => {
  const rows = new Map<string, any>(), collections = new Map<string, any>();
  const identity = (query: any) => query.routineId + ':' + query.platform + ':' + query.definitionRevision;
  const chain = (get: () => unknown) => ({read() {return this;}, readConcern() {return this;}, sort() {return this;}, select() {return this;}, session() {return this;}, lean: async () => get()});
  const find = spyOn(RoutineDefinitionModel, 'findOne').mockImplementation((query?: any) => chain(() => rows.get(identity(query)) ?? null) as any);
  const publication = spyOn(RoutineCollectionModel, 'findOne').mockImplementation((query?: any) => chain(() => {
    const values = [...collections.values()];
    return query?.$or ? values.find(row => query.$or.some((part: any) => part.commit === row.commit || part.version === row.version)) ?? null
      : query?.commit ? collections.get(query.commit) ?? null : values.sort((a, b) => b.version - a.version)[0] ?? null;
  }) as any);
  const all = spyOn(RoutineDefinitionModel, 'find').mockImplementation((query?: any) => chain(() => [...rows.values()]
    .filter(row => row.definitionRevision === query.definitionRevision && query.$or.some((member: any) => member.routineId === row.routineId && member.platform === row.platform))
    .map(({ordinaryEnrolledAt: _at, ...row}) => row)) as any);
  const insert = spyOn(RoutineDefinitionModel, 'create').mockImplementation(async (values: any) => {
    for (const row of values) rows.set(identity(row), structuredClone(row)); return values;
  });
  const savePublication = spyOn(RoutineCollectionModel, 'create').mockImplementation(async (values: any) => {
    for (const row of values) collections.set(row.commit, structuredClone(row)); return values;
  });
  const update = spyOn(RoutineDefinitionModel, 'updateOne').mockImplementation(((query: any, values: any) => {
    Object.assign(rows.get(identity(query)), values.$set); return Promise.resolve({matchedCount: 1});
  }) as any);
  const transaction = spyOn(RoutineDefinitionModel.db, 'transaction').mockImplementation((async (fn: any) => {
    const beforeRows = structuredClone(rows), beforeCollections = structuredClone(collections);
    try {await fn({});} catch (error) {
      rows.clear(); for (const [key, value] of beforeRows) rows.set(key, value);
      collections.clear(); for (const [key, value] of beforeCollections) collections.set(key, value);
      throw error;
    }
  }) as any);
  const service = new RoutineDefinitionService(undefined, undefined, null);
  const at = (revision: string, id = 'no-glasses') => {
    const row = enrollment(), definition = {...row.definition, id, source: {...row.definition.source, revision, path: `routines/${id}/routine.ts`}};
    return {...row, routineId: id, definition, definitionRevision: revision,
      definitionSha256: requestInputDigest(definition), routineSource: testRoutineSource(revision)};
  };
  try {
    const a = at('c'.repeat(40)), b = at(a.definitionRevision, 'notes'), c = at(a.definitionRevision, 'captions');
    const original = {commit:a.definitionRevision, version:30, definitions:[a,b]};
    await service.publishCollection(original);
    expect(await service.current()).toEqual([a,b]);
    const counts = [insert.mock.calls.length, savePublication.mock.calls.length];
    await service.publishCollection({...original, definitions:[b,a]});
    expect([insert.mock.calls.length, savePublication.mock.calls.length]).toEqual(counts);
    for (const changed of [
      {...original, definitions:[a,c]}, {...original, definitions:[a]}, {...original, definitions:[a,b,c]},
      {...original, version:31}, {commit:'b'.repeat(40), version:30, definitions:[at('b'.repeat(40))]},
    ]) await expect(service.publishCollection(changed)).rejects.toThrow('manifest conflicts');
    expect(await service.current()).toEqual([a,b]);
    const conflict = {...a, routineSource:{...a.routineSource,bundle:{...a.routineSource.bundle,sha256:'f'.repeat(64)}}};
    await expect(service.publishCollection({...original, definitions:[conflict,b]})).rejects.toThrow('manifest conflicts');
    await expect(service.publishCollection({...original, definitions:[a,a]})).rejects.toThrow('identity');
    await expect(service.publishCollection({version:-1})).rejects.toThrow('Invalid published collection');
    await service.publishCollection({commit:'b'.repeat(40), version:20, definitions:[at('b'.repeat(40))]});
    expect(await service.current()).toEqual([a,b]);
    const next = at('d'.repeat(40));
    // A reader which already chose a receipt must still read that exact membership after newer publication.
    const readRows = all.getMockImplementation()!;
    all.mockImplementation(((query: any) => chain(async () => {
      await service.publishCollection({commit:next.definitionRevision, version:40, definitions:[next]});
      const result = readRows(query) as any; return result.lean();
    })) as any);
    expect(await service.current()).toEqual([a,b]);
    all.mockImplementation(readRows);
    expect(await service.current()).toEqual([next]);
    const legacy = at('e'.repeat(40));
    rows.set(identity(legacy), {...legacy, routineSource: undefined});
    await expect(service.publishCollection({commit:legacy.definitionRevision, version:50, definitions:[legacy]})).rejects.toThrow('bytes conflict');
    expect(await service.current()).toEqual([next]);
  } finally {find.mockRestore(); publication.mockRestore(); all.mockRestore(); insert.mockRestore(); savePublication.mockRestore(); update.mockRestore(); transaction.mockRestore();}
});

test('exact manual selection requires an ordinary enrollment while candidate readers retain exact source', async () => {
  const row = enrollment();
  const find = spyOn(RoutineDefinitionModel, 'findOne').mockImplementation((query?: any) => ({read() {return this;}, readConcern() {return this;}, lean: async () =>
    query?.ordinaryEnrolledAt ? null : row}) as any);
  try {
    const service = new RoutineDefinitionService(undefined, undefined, null);
    expect(await service.getExact(row.routineId, row.platform, row.definitionRevision)).toEqual(row);
    expect(await service.getExact(row.routineId, row.platform, row.definitionRevision, true)).toBeNull();
    expect(find.mock.calls[1]?.[0]).toMatchObject({ordinaryEnrolledAt: {$exists: true}});
  } finally {find.mockRestore();}
});
