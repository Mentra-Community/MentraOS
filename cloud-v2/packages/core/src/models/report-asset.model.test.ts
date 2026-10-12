import {expect, test} from 'bun:test';
import {reconcileReportAssetIndexes, ReportAssetModel} from './report-asset.model';

test('report artifacts stay unique while separate reports can reference the same storage key', () => {
  const indexes = ReportAssetModel.schema.indexes();
  expect(indexes.find(([key]) => key.artifactId === 1)?.[1].unique).toBe(true);
  expect(indexes.some(([key, options]) => key.storageKey === 1 && options.unique)).toBe(false);
});

test('shared reference index cutover drops only the former unique storage key', async () => {
  const indexes = [
    {name: '_id_', key: {_id: 1}, unique: true},
    {name: 'artifactId_1', key: {artifactId: 1}, unique: true},
    {name: 'storageKey_1', key: {storageKey: 1}, unique: true},
    {name: 'reportId_1', key: {reportId: 1}},
  ];
  const dropped: string[] = [];
  const collection = {
    listIndexes() {return {async toArray() {return indexes;}};},
    async dropIndex(name: string) {dropped.push(name); indexes.splice(indexes.findIndex(index => index.name === name), 1);},
  };
  await reconcileReportAssetIndexes(collection as unknown as Parameters<typeof reconcileReportAssetIndexes>[0]);
  await reconcileReportAssetIndexes(collection as unknown as Parameters<typeof reconcileReportAssetIndexes>[0]);
  expect(dropped).toEqual(['storageKey_1']);
});

test('index cutover accepts a missing collection or an index concurrently removed by another instance', async () => {
  await reconcileReportAssetIndexes({listIndexes() {return {async toArray() {throw {code: 26};}};}} as unknown as Parameters<typeof reconcileReportAssetIndexes>[0]);
  await reconcileReportAssetIndexes({listIndexes() {return {async toArray() {return [{name: 'storageKey_1', key: {storageKey: 1}, unique: true}];}};},
    async dropIndex() {throw {code: 27};}} as unknown as Parameters<typeof reconcileReportAssetIndexes>[0]);
});

test('a real index read or drop failure prevents serving with the conflicting constraint', async () => {
  const failure = new Error('Index operation unavailable');
  await expect(reconcileReportAssetIndexes({listIndexes() {return {async toArray() {throw failure;}};}} as unknown as Parameters<typeof reconcileReportAssetIndexes>[0])).rejects.toBe(failure);
  await expect(reconcileReportAssetIndexes({listIndexes() {return {async toArray() {return [{name: 'storageKey_1', key: {storageKey: 1}, unique: true}];}};},
    async dropIndex() {throw failure;}} as unknown as Parameters<typeof reconcileReportAssetIndexes>[0])).rejects.toBe(failure);
});
