import {expect, test} from "bun:test";
import {reconcileTestRunIndexes, TestRunModel, TEST_RUN_COMPLETION_INDEX} from "./test-run.model";

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
