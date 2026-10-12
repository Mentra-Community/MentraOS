import {expect, test} from "bun:test";
import {reconcileTestRunIndexes, TestRunModel, TEST_RUN_COMPLETION_INDEX, TEST_RUN_NATIVE_HISTORY_INDEX} from "./test-run.model";

test("index cutover removes conflicting definitions without touching historical documents", async () => {
  expect(TestRunModel.schema.options.autoIndex).toBe(false);
  const indexes = [
    {name: "_id_", key: {_id: 1}}, {name: "requestId_1", key: {requestId: 1}},
    {name: TEST_RUN_COMPLETION_INDEX, key: {completedAt: -1, startedAt: -1, runId: -1}},
    {name: "runId_1", key: {runId: 1}, unique: true},
  ];
  const dropped: string[] = [];
  await reconcileTestRunIndexes({listIndexes() {return {async toArray() {return indexes;}};}, async dropIndex(name: string) {dropped.push(name);}} as any);
  expect(dropped).toEqual(["requestId_1", TEST_RUN_COMPLETION_INDEX]);
  const request = TestRunModel.schema.indexes().find(([key]) => Object.keys(key).length === 1 && key.requestId === 1);
  expect(request?.[1].unique).toBe(true);
  expect(request?.[1].partialFilterExpression).toEqual({"payload.schemaVersion": 1});
  dropped.length = 0;
  await reconcileTestRunIndexes({listIndexes() {return {async toArray() {return [
    {name: "test_runs_terminal_request", key: {requestId: 1}, unique: true, partialFilterExpression: {"payload.schemaVersion": 1}},
    {name: TEST_RUN_COMPLETION_INDEX, key: {completedAt: -1, runId: -1}},
  ];}};}, async dropIndex(name: string) {dropped.push(name);}} as any);
  expect(dropped).toEqual([]);
});

test("native history index filters before sorting without a conflicting full-history key", async () => {
  const expected = {"payload.schemaVersion": 1, startedAt: -1, runId: -1} as const;
  const definitions = TestRunModel.schema.indexes();
  const native = definitions.find(([, options]) => options.name === TEST_RUN_NATIVE_HISTORY_INDEX);
  expect(native?.[0]).toEqual(expected);
  expect(native?.[1].partialFilterExpression).toBeUndefined();
  expect(definitions.filter(([key]) => JSON.stringify(key) === JSON.stringify({startedAt: -1, runId: -1}))).toHaveLength(1);

  const dropped: string[] = [];
  let indexes = [
    {name: "startedAt_-1_runId_-1", key: {startedAt: -1, runId: -1}},
    {name: TEST_RUN_NATIVE_HISTORY_INDEX, key: {startedAt: -1, runId: -1}, partialFilterExpression: {"payload.schemaVersion": 1}},
    {name: "test_runs_terminal_request", key: {requestId: 1}, unique: true, partialFilterExpression: {"payload.schemaVersion": 1}},
  ];
  const collection = {listIndexes() {return {async toArray() {return indexes;}};}, async dropIndex(name: string) {dropped.push(name);}};
  await reconcileTestRunIndexes(collection as any);
  expect(dropped).toEqual([TEST_RUN_NATIVE_HISTORY_INDEX]);
  dropped.length = 0;
  indexes = [{name: TEST_RUN_NATIVE_HISTORY_INDEX, key: expected}] as typeof indexes;
  await reconcileTestRunIndexes(collection as any);
  expect(dropped).toEqual([]);
});
