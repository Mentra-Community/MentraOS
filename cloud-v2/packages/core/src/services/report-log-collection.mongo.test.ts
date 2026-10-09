import {expect, spyOn, test} from 'bun:test'
import mongoose from 'mongoose'
import {randomUUID} from 'node:crypto'
import {mkdtemp, rm} from 'node:fs/promises'
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
  } finally {
    verify.mockRestore()
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    await rm(directory, {recursive: true, force: true})
  }
}, 30_000)
