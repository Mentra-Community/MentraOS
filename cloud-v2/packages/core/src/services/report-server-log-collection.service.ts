import {ReportModel} from '../models/report.model'
import {addLogArtifact, updateReportLogCollection} from './report.service'
import {collectServerLogs, ServerLogCollectionError} from './report-cloud-logs'
import type {ReportLogSource} from './report-log-collection'

/** Existing report rows are the durable work list; the Core reconciliation tick owns collection. */
export class ReportServerLogCollectionService {
  async tick() {
    await Promise.allSettled((['cloud', 'miniapp_server'] as const).map(source => this.collectNext(source)))
  }
  private async collectNext(source: Extract<ReportLogSource, 'cloud' | 'miniapp_server'>) {
    const now = new Date(), field = `logCollection.${source}`
    const report = await ReportModel.findOneAndUpdate({
      kind: {$in: ['bug', 'automatic']}, createdAt: {$gte: new Date(now.getTime() - 24 * 60 * 60_000), $lte: new Date(now.getTime() - 30_000)},
      [`${field}.state`]: 'requested',
      $or: [{[`${field}.leaseUntil`]: {$exists: false}}, {[`${field}.leaseUntil`]: {$lte: now}}],
    }, {$set: {[`${field}.leaseUntil`]: new Date(now.getTime() + 60_000)}}, {sort: {createdAt: 1}, returnDocument: 'after'}).lean()
    if (!report) return
    const owner = {mentraUserId: report.mentraUserId, reportId: report.reportId, source}
    try {
      const entries = await collectServerLogs({...owner, createdAt: report.createdAt})
      if (!entries.length) {
        // Vector ingestion may lag the first lookup. The existing lease allows a
        // later tick to retry the same incident window, up to its original deadline.
        const deadlineAt = report.logCollection?.[source]?.deadlineAt
        if (deadlineAt && Date.parse(deadlineAt) > Date.now()) return
        await updateReportLogCollection({...owner, state: 'unavailable', reason: source === 'miniapp_server'
          ? 'No user-correlated miniapp server logs found; backend logs must include mentraUserId or userId'
          : 'No user-correlated cloud logs found in the incident window'})
        return
      }
      await addLogArtifact({...owner, entries})
    } catch (error) {
      await updateReportLogCollection({...owner, state: 'failed', reason: error instanceof ServerLogCollectionError ? error.reason : 'Server log artifact storage failed'})
    }
  }
}
