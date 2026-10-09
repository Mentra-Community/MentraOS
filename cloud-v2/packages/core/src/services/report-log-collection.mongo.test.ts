import {expect, spyOn, test} from 'bun:test'
import mongoose from 'mongoose'
import {randomUUID} from 'node:crypto'
import {mkdtemp, readdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Hono} from 'hono'
import type {AppEnv} from '../types/hono.types'
import {ReportModel} from '../models/report.model'
import {ReportAssetModel} from '../models/report-asset.model'
import {addLogArtifact, getReport, submitReport, updateReportLogCollection} from './report.service'
import {initialReportLogCollection} from './report-log-collection'
import reportsApi from '../api/client/reports.api'
import * as session from './session.service'
import {OauthError} from '../types/oauth.types'

const uri = process.env.REPORT_COLLECTION_MONGO_URI
;(uri ? test : test.skip)('real Mongo report receipt, late failures, stored bytes and authenticated source authority', async () => {
  if (!uri?.startsWith('mongodb://127.0.0.1:')) throw new Error('Explicit loopback Mongo required')
  const directory = await mkdtemp(join(tmpdir(), 'mentra-source-receipt-'))
  process.env.CLOUD_STORAGE_PROVIDER = 'local'
  process.env.CLOUD_STORAGE_LOCAL_DIR = directory
  await mongoose.connect(uri, {dbName: `report_sources_${randomUUID().replaceAll('-', '')}`})
  const userId = 'mu_01M2JJVEVTR0DJJD5Z6AN3GTM2'
  const verify = spyOn(session, 'verifyAccessToken').mockResolvedValue({
    mentraUserId: userId, tenantId: 'mentra', sessionId: 'session', jti: 'jti', exp: Math.floor(Date.now() / 1000) + 100,
  } as Awaited<ReturnType<typeof session.verifyAccessToken>>)
  try {
    await Promise.all([ReportModel.createIndexes(), ReportAssetModel.createIndexes()])
    const input = {mentraUserId: userId, kind: 'bug' as const, trigger: {type: 'manual' as const, source: 'test', reason: 'source-receipt'}, report: {actualBehavior: 'Synthetic report collection verification'}, context: {}}
    const {reportId} = await submitReport(input)
    const before = await getReport(reportId)
    expect(Object.keys(before!.report.logCollection!)).toHaveLength(5)
    expect(before!.report.logCollection!.glasses!.state).toBe('requested')
    await updateReportLogCollection({mentraUserId: userId, reportId, source: 'glasses', state: 'failed', reason: 'incident_dispatch_timeout'})
    const entries = [{timestamp: Date.now(), level: 'info', message: 'Original glasses payload'}]
    await addLogArtifact({mentraUserId: userId, reportId, source: 'glasses', entries})
    await updateReportLogCollection({mentraUserId: userId, reportId, source: 'glasses', state: 'failed', reason: 'late failure'})
    const received = await getReport(reportId), receipt = received!.report.logCollection!.glasses!
    expect(receipt).toMatchObject({state: 'received', entryCount: 1})
    expect(receipt.requestedAt).toBe(before!.report.logCollection!.glasses!.requestedAt)
    expect(receipt.reason).toBeUndefined()
    expect(received!.report.artifacts[0]!.artifactId).toBe(receipt.artifactId!)
    const asset = await ReportAssetModel.findOne({artifactId: receipt.artifactId}).lean()
    expect(await Bun.file(join(directory, asset!.storageKey)).json()).toEqual({entries})
    await addLogArtifact({mentraUserId: userId, reportId, source: 'phone', entries: []})
    expect((await getReport(reportId))!.report.logCollection!.phone).toMatchObject({state: 'received', entryCount: 0})
    expect(await addLogArtifact({mentraUserId: 'other-user', reportId, source: 'cloud', entries})).toBeNull()
    expect(await updateReportLogCollection({mentraUserId: 'other-user', reportId, source: 'glasses_firmware', state: 'failed'})).toBe(false)
    const expired = initialReportLogCollection(new Date(Date.now() - 300_000))
    await ReportModel.updateOne({reportId}, {$set: {'logCollection.glasses_firmware': expired.glasses_firmware}})
    expect((await getReport(reportId))!.report.logCollection!.glasses_firmware!.state).toBe('timed-out')
    await addLogArtifact({mentraUserId: userId, reportId, source: 'glasses_firmware', entries})
    expect((await getReport(reportId))!.report.logCollection!.glasses_firmware!.state).toBe('received')
    const app = new Hono<AppEnv>().route('/', reportsApi)
    app.onError((error, c) => error instanceof OauthError ? c.json({error: error.code}, error.httpStatus as 400) : c.json({error: 'server_error'}, 500))
    const call = (source: string, body: unknown) => app.request(`/${reportId}/log-collection/${source}`, {method: 'POST', headers: {Authorization: 'Bearer synthetic', 'Content-Type': 'application/json'}, body: JSON.stringify(body)})
    expect((await call('cloud', {state: 'failed', reason: 'device cannot own server'})).status).toBe(400)
    expect((await call('phone', {state: 'received'})).status).toBe(400)
    expect((await call('glasses', {state: 'failed', reason: 'late device outcome'})).status).toBe(200)
    expect((await getReport(reportId))!.report.logCollection!.glasses!.state).toBe('received')
    const upload = (source: string) => app.request(`/${reportId}/artifacts`, {method: 'POST',
      headers: {Authorization: 'Bearer synthetic', 'Content-Type': 'application/json'},
      body: JSON.stringify({type: 'logs', source, entries})})
    for (const source of ['cloud', 'miniapp_server']) {
      const beforeUpload = await ReportModel.findOne({reportId}).lean(), count = await ReportAssetModel.countDocuments({reportId}),
        filesBefore = (await readdir(directory, {recursive: true})).sort()
      expect((await upload(source)).status).toBe(400)
      expect((await ReportModel.findOne({reportId}).lean())!.logCollection).toEqual(beforeUpload!.logCollection)
      expect(await ReportAssetModel.countDocuments({reportId})).toBe(count)
      expect((await readdir(directory, {recursive: true})).sort()).toEqual(filesBefore)
      expect((await addLogArtifact({mentraUserId: userId, reportId, source, entries}))!.stored).toBe(1)
      expect((await getReport(reportId))!.report.logCollection![source as 'cloud' | 'miniapp_server']).toMatchObject({state: 'received', entryCount: 1})
    }
    expect((await upload('phone')).status).toBe(200)

    for (const concurrent of [false, true]) {
      const originalCollection = initialReportLogCollection(new Date())
      const targetId = `rep_rollback${randomUUID().replaceAll('-', '')}`
      await ReportModel.create({reportId: targetId, mentraUserId: userId, kind: 'bug', status: 'collecting',
        artifacts: [], logCollection: originalCollection, context: {}})
      const foreignId = `rep_foreign${randomUUID().replaceAll('-', '')}`
      await ReportModel.create({reportId: foreignId, mentraUserId: 'other-user', kind: 'bug', status: 'collecting',
        artifacts: [], logCollection: originalCollection, context: {}})
      const originalUpdate = ReportModel.updateOne.bind(ReportModel)
      let intercepted = false, rolledBackId = '', newerReceipt: unknown
      const update = spyOn(ReportModel, 'updateOne').mockImplementation((async (filter: any, change: any, options: any) => {
        const result = await originalUpdate(filter, change, options)
        if (!intercepted && filter.reportId === targetId && change.$push?.artifacts) {
          intercepted = true; rolledBackId = change.$push.artifacts.$each[0].artifactId
          // Exercise a real successful Mongo update whose client observes an ambiguous failure.
          if (concurrent) {
            await addLogArtifact({mentraUserId: userId, reportId: targetId, source: 'phone', entries: [{...entries[0]!, message: 'Newer accepted artifact'}]})
            newerReceipt = (await ReportModel.findOne({reportId: targetId}).lean())!.logCollection!.phone
          }
          throw new Error('Synthetic response loss after applied Mongo update')
        }
        return result
      }) as any)
      try {
        await expect(addLogArtifact({mentraUserId: userId, reportId: targetId, source: 'phone', entries}))
          .rejects.toThrow('Synthetic response loss after applied Mongo update')
      } finally {update.mockRestore()}
      const row = (await ReportModel.findOne({reportId: targetId}).lean())!, receipt = row.logCollection!.phone!
      expect(row.artifacts.some(artifact => artifact.artifactId === rolledBackId)).toBe(false)
      expect(await ReportAssetModel.exists({artifactId: rolledBackId})).toBeNull()
      expect(await Bun.file(join(directory, `reports/${targetId}/${rolledBackId}`)).exists()).toBe(false)
      expect((await ReportModel.findOne({reportId: foreignId}).lean())!.logCollection).toEqual(originalCollection)
      if (concurrent) {
        expect(newerReceipt).toEqual(receipt)
        expect(receipt.state).toBe('received'); expect(row.artifacts).toHaveLength(1)
        const newerAsset = (await ReportAssetModel.findOne({artifactId: receipt.artifactId}).lean())!
        expect(await Bun.file(join(directory, newerAsset.storageKey)).json()).toEqual({entries: [{...entries[0]!, message: 'Newer accepted artifact'}]})
      } else {
        expect(receipt).toMatchObject({state: 'failed', reason: 'Artifact storage acceptance was rolled back',
          requestedAt: originalCollection.phone.requestedAt, deadlineAt: originalCollection.phone.deadlineAt})
        expect(receipt.artifactId).toBeUndefined(); expect(receipt.receivedAt).toBeUndefined(); expect(receipt.entryCount).toBeUndefined()
        await addLogArtifact({mentraUserId: userId, reportId: targetId, source: 'phone', entries})
        expect((await getReport(targetId))!.report.logCollection!.phone!.state).toBe('received')
      }
    }
  } finally {
    verify.mockRestore()
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    await rm(directory, {recursive: true, force: true})
  }
}, 30_000)
