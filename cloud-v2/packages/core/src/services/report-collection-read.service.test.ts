import {afterEach, describe, expect, spyOn, test} from 'bun:test'
import {Hono} from 'hono'

import reportsApi from '../api/client/reports.api'
import {ReportModel} from '../models/report.model'
import type {AppEnv} from '../types/hono.types'
import {InvalidGrant, OauthError} from '../types/oauth.types'
import {initialReportLogCollection} from './report-log-collection'
import {getReportLogCollection} from './report.service'
import * as session from './session.service'

const mocks: Array<{mockRestore(): void}> = []
afterEach(() => mocks.splice(0).forEach((mock) => mock.mockRestore()))

const reportId = 'rep_COLLECTION_READ'
const ownerId = 'mu_collection_owner'
const otherUserId = 'mu_other_user'
const projection = {_id: 0, reportId: 1, logCollection: 1}
const headers = {Authorization: 'Bearer synthetic-access-token'}

function mockLookup(row: unknown) {
  const read = spyOn(ReportModel, 'findOne').mockImplementation((() => ({lean: async () => row})) as never)
  mocks.push(read)
  return read
}

function authenticate(mentraUserId = ownerId, tenantId = 'enterprise-synthetic') {
  const verify = spyOn(session, 'verifyAccessToken').mockResolvedValue({
    mentraUserId,
    tenantId,
    sessionId: 'synthetic-private-session',
    jti: 'synthetic-private-jti',
    exp: Math.floor(Date.now() / 1000) + 300,
  } as Awaited<ReturnType<typeof session.verifyAccessToken>>)
  mocks.push(verify)
  return verify
}

function app() {
  const api = new Hono<AppEnv>().route('/api/client/reports', reportsApi)
  api.onError((error, c) =>
    error instanceof OauthError
      ? c.json({error: error.code, error_description: error.description}, error.httpStatus as 400)
      : c.json({error: 'server_error'}, 500),
  )
  return api
}

describe('getReportLogCollection', () => {
  test('queries only the authenticated owner and projects collection fields', async () => {
    const collection = initialReportLogCollection(new Date(Date.now() + 60_000))
    collection.phone = {...collection.phone, state: 'received', artifactId: 'art_PHONE', entryCount: 2}
    const read = mockLookup({
      reportId,
      mentraUserId: ownerId,
      logCollection: collection,
      context: {privateDeviceState: 'private-context'},
      artifacts: [{artifactId: 'art_PRIVATE', storageKey: 'private/storage/key'}],
      assets: [{url: 'https://private.invalid/signed-asset?token=private'}],
      accessToken: 'private-token',
      _id: 'private-mongo-id',
    })

    const result = await getReportLogCollection({reportId, mentraUserId: ownerId})

    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({reportId, mentraUserId: ownerId}, projection)
    expect(result).toEqual({reportId, logCollection: collection})
    expect(Object.keys(result!)).toEqual(['reportId', 'logCollection'])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  test('returns null when the owner-scoped report does not exist', async () => {
    const read = mockLookup(null)

    expect(await getReportLogCollection({reportId, mentraUserId: otherUserId})).toBeNull()
    expect(read).toHaveBeenCalledWith({reportId, mentraUserId: otherUserId}, projection)
  })

  test('returns an empty collection for a report created before receipts existed', async () => {
    mockLookup({reportId})

    expect(await getReportLogCollection({reportId, mentraUserId: ownerId})).toEqual({reportId, logCollection: {}})
  })

  test('renders expired requested receipts as timed-out without changing stored receipts', async () => {
    const collection = initialReportLogCollection(new Date(Date.now() - 300_000))
    collection.phone = {...collection.phone, state: 'received', artifactId: 'art_PHONE', entryCount: 0}
    collection.cloud = {...collection.cloud, state: 'failed', reason: 'Server query unavailable'}
    const before = structuredClone(collection)
    mockLookup({reportId, logCollection: collection})

    const result = await getReportLogCollection({reportId, mentraUserId: ownerId})

    expect(result!.logCollection.glasses).toEqual({
      ...collection.glasses,
      state: 'timed-out',
      reason: 'No log artifact arrived before the collection deadline',
    })
    expect(result!.logCollection.phone).toEqual(collection.phone)
    expect(result!.logCollection.cloud).toEqual(collection.cloud)
    expect(collection).toEqual(before)
  })
})

describe('GET /api/client/reports/:reportId/log-collection', () => {
  test('uses verified user identity and returns only compact receipt state', async () => {
    const verify = authenticate()
    const collection = initialReportLogCollection(new Date(Date.now() + 60_000))
    const read = mockLookup({
      reportId,
      logCollection: collection,
      context: {accessToken: 'private-context-token'},
      assets: [{storageKey: 'private-asset-key'}],
      artifacts: [{artifactId: 'art_PRIVATE'}],
    })

    const response = await app().request(
      `/api/client/reports/${reportId}/log-collection?mentraUserId=${otherUserId}&tenantId=other-tenant`,
      {headers},
    )
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(verify).toHaveBeenCalledWith('synthetic-access-token')
    expect(read).toHaveBeenCalledWith({reportId, mentraUserId: ownerId}, projection)
    expect(body).toEqual({reportId, logCollection: collection})
    expect(Object.keys(body)).toEqual(['reportId', 'logCollection'])
    for (const secret of ['private', 'synthetic-access-token', 'synthetic-private-session', 'synthetic-private-jti']) {
      expect(JSON.stringify(body)).not.toContain(secret)
    }
  })

  test('returns the same not-found response for an unknown report and another owner report', async () => {
    authenticate(otherUserId)
    const read = mockLookup(null)
    const api = app()

    for (const id of [reportId, 'rep_MISSING']) {
      const response = await api.request(`/api/client/reports/${id}/log-collection`, {headers})
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({error: 'report not found'})
      expect(read).toHaveBeenLastCalledWith({reportId: id, mentraUserId: otherUserId}, projection)
    }
    expect(read).toHaveBeenCalledTimes(2)
  })

  test('returns timed-out state when a requested source has passed its deadline', async () => {
    authenticate()
    const collection = initialReportLogCollection(new Date(Date.now() - 300_000))
    mockLookup({reportId, logCollection: {glasses_firmware: collection.glasses_firmware}})

    const response = await app().request(`/api/client/reports/${reportId}/log-collection`, {headers})

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reportId,
      logCollection: {
        glasses_firmware: {
          ...collection.glasses_firmware,
          state: 'timed-out',
          reason: 'No log artifact arrived before the collection deadline',
        },
      },
    })
  })

  test.each([undefined, 'Basic synthetic', 'Bearer '])(
    'rejects a missing or malformed bearer %p before any database read',
    async (authorization) => {
      const verify = authenticate()
      const read = mockLookup({reportId})
      const response = await app().request(`/api/client/reports/${reportId}/log-collection`, {
        headers: authorization === undefined ? {} : {Authorization: authorization},
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({error: 'invalid_request'})
      expect(verify).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
    },
  )

  test('rejects an invalid access token before reading any report', async () => {
    const verify = authenticate()
    verify.mockRejectedValue(new InvalidGrant('access_token expired'))
    const read = mockLookup({reportId})
    const response = await app().request(`/api/client/reports/${reportId}/log-collection`, {headers})

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({error: 'invalid_grant', error_description: 'access_token expired'})
    expect(verify).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })
})
