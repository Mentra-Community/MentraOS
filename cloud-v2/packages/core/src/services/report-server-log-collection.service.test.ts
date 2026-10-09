import {afterEach, expect, spyOn, test} from 'bun:test'
import {ReportModel} from '../models/report.model'
import * as reports from './report.service'
import * as serverLogs from './report-cloud-logs'
import {ReportServerLogCollectionService} from './report-server-log-collection.service'
import {initialReportLogCollection} from './report-log-collection'

const mocks: Array<{mockRestore(): void}> = []
afterEach(() => mocks.splice(0).forEach(mock => mock.mockRestore()))
const createdAt = new Date('2026-10-09T16:00:00Z')
const row = {reportId: 'rep_SYNTHETIC', mentraUserId: 'mu_01M2JJVEVTR0DJJD5Z6AN3GTM2', createdAt}
function setup(deadlineAt = new Date(Date.now() - 1).toISOString()) {
  const logCollection = initialReportLogCollection(createdAt)
  logCollection.cloud.deadlineAt = deadlineAt
  logCollection.miniapp_server.deadlineAt = deadlineAt
  const filters: Array<Record<string, unknown>> = []
  mocks.push(spyOn(ReportModel, 'findOneAndUpdate').mockImplementation(((filter: Record<string, unknown>, update: Record<string, unknown>, options: unknown) => {
    filters.push(filter)
    expect(options).toEqual({sort: {createdAt: 1}, returnDocument: 'after'})
    const field = 'logCollection.' + (filter['logCollection.cloud.state'] ? 'cloud' : 'miniapp_server')
    expect(filter[`${field}.state`]).toBe('requested')
    expect(filter.$or).toBeDefined()
    expect((update.$set as Record<string, unknown>)[`${field}.leaseUntil`]).toBeInstanceOf(Date)
    return {lean: async () => ({...row, logCollection})}
  }) as never))
  const collect = spyOn(serverLogs, 'collectServerLogs').mockResolvedValue([{timestamp: createdAt.getTime(), level: 'info', message: 'original bounded logs'}])
  const attach = spyOn(reports, 'addLogArtifact').mockResolvedValue({stored: 1})
  const outcome = spyOn(reports, 'updateReportLogCollection').mockResolvedValue(true)
  mocks.push(collect, attach, outcome)
  return {collect, attach, outcome, filters}
}
test('durable report claims bind the original user/time and attach both server sources independently', async () => {
  const fixture = setup()
  await new ReportServerLogCollectionService().tick()
  expect(fixture.collect.mock.calls.map(([input]) => input)).toEqual([
    {...row, source: 'cloud'}, {...row, source: 'miniapp_server'},
  ])
  expect(fixture.attach).toHaveBeenCalledTimes(2)
  expect(fixture.outcome).not.toHaveBeenCalled()
})
test('one query failure records its reason and does not suppress the other server artifact', async () => {
  const fixture = setup()
  fixture.collect.mockRejectedValueOnce(new serverLogs.ServerLogCollectionError('query unavailable'))
  await new ReportServerLogCollectionService().tick()
  expect(fixture.attach).toHaveBeenCalledTimes(1)
  expect(fixture.attach.mock.calls[0]![0].source).toBe('miniapp_server')
  expect(fixture.outcome).toHaveBeenCalledWith({reportId: row.reportId, mentraUserId: row.mentraUserId, source: 'cloud', state: 'failed', reason: 'query unavailable'})
})
test('no user-correlated logs is explicit unavailable and never a fabricated received artifact', async () => {
  const fixture = setup()
  fixture.collect.mockResolvedValue([])
  await new ReportServerLogCollectionService().tick()
  expect(fixture.attach).not.toHaveBeenCalled()
  expect(fixture.outcome).toHaveBeenCalledTimes(2)
  expect(fixture.outcome.mock.calls[1]![0]).toMatchObject({source: 'miniapp_server', state: 'unavailable', reason: 'No matching miniapp server logs found in the configured source for the incident window'})
})
test('empty lookup before the deadline remains eligible and a later tick attaches ingested logs', async () => {
  const fixture = setup(new Date(Date.now() + 60_000).toISOString())
  fixture.collect.mockResolvedValueOnce([]).mockResolvedValueOnce([])
  const collector = new ReportServerLogCollectionService()
  await collector.tick()
  expect(fixture.attach).not.toHaveBeenCalled()
  expect(fixture.outcome).not.toHaveBeenCalled()
  await collector.tick()
  expect(fixture.attach).toHaveBeenCalledTimes(2)
  expect(fixture.outcome).not.toHaveBeenCalled()
})
test('an unclaimed report does no query or storage work', async () => {
  const fixture = setup()
  mocks.push(spyOn(ReportModel, 'findOneAndUpdate').mockImplementation((() => ({lean: async () => null})) as never))
  await new ReportServerLogCollectionService().tick()
  expect(fixture.collect).not.toHaveBeenCalled()
  expect(fixture.attach).not.toHaveBeenCalled()
})
test('storage rejection is a failed source, never a received acknowledgement', async () => {
  const fixture = setup()
  fixture.attach.mockRejectedValueOnce(new Error('storage private error'))
  await new ReportServerLogCollectionService().tick()
  expect(fixture.outcome.mock.calls[0]![0]).toMatchObject({source: 'cloud', state: 'failed', reason: 'Server log artifact storage failed'})
})
