/** Read existing Vector/Better Stack logs; never ship logs from the Core process. */
import {z} from 'zod'
import type {ReportLogEntry} from './report.service'

export const SERVER_LOG_MAX_ENTRIES = 1000
const SERVER_LOG_MAX_BYTES = 2 * 1024 * 1024
const ENV_TABLES: Record<string, string> = {
  dev: 'mentracloud_v2_dev_2', debug: 'mentracloud_v2_debug', isaiah: 'mentracloud_v2_isaiah',
  staging: 'mentracloud_v2_staging', prod: 'mentracloud_v2_prod',
}
const rowSchema = z.object({dt: z.string(), raw: z.string()})
export class ServerLogCollectionError extends Error {
  constructor(readonly reason: string, readonly transient = false) { super(reason) }
}

export function serverLogQuery(source: 'cloud' | 'miniapp_server', environment: string, userId: string, createdAt: Date): string {
  const cloudTable = ENV_TABLES[environment]
  if (!cloudTable) throw new ServerLogCollectionError('Cloud log environment is not configured')
  if (!/^mu_[A-Z0-9]{26}$/.test(userId)) throw new ServerLogCollectionError('Report has no authenticated device user for server log lookup')
  const tables = source === 'cloud' ? [cloudTable] : [environment === 'prod' ? 'mentra_miniapps_prod' : environment === 'dev' ? 'mentra_miniapps_dev' : 'mentra_miniapps_other']
  const start = new Date(createdAt.getTime() - 10 * 60_000).toISOString().replace('T', ' ').replace('Z', '')
  const end = new Date(createdAt.getTime() + 10_000).toISOString().replace('T', ' ').replace('Z', '')
  const identity = `unhex('${Buffer.from(userId).toString('hex')}')`
  const where = `dt BETWEEN toDateTime64('${start}',3,'UTC') AND toDateTime64('${end}',3,'UTC') AND (JSONExtractString(raw,'mentraUserId')=${identity} OR JSONExtractString(raw,'userId')=${identity} OR position(JSONExtractString(raw,'message'),${identity})>0)`
  const reads = tables.flatMap(table => [
    `SELECT dt,raw FROM remote(t373499_${table}_logs) WHERE ${where}`,
    `SELECT dt,raw FROM s3Cluster(primary,t373499_${table}_s3) WHERE _row_type=1 AND ${where}`,
  ])
  return `SELECT dt,raw FROM (${reads.join(' UNION ALL ')}) GROUP BY dt,raw ORDER BY dt DESC LIMIT ${SERVER_LOG_MAX_ENTRIES + 1} FORMAT JSONEachRow`
}

function scrubString(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:xox[baprs]-|msk_)[A-Za-z0-9-]+/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b((?:access|refresh|core|api)[_-]?(?:token|key)|password|secret)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
}
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (typeof value === 'string') return scrubString(value).slice(0, 16_384)
  if (Array.isArray(value)) return value.slice(0, 100).map(item => scrub(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key,
    /authorization|cookie|password|secret|token|api[_-]?key/i.test(key) ? '[REDACTED]' : scrub(item, depth + 1),
  ]))
  return value
}
export function parseServerLogs(text: string, userId: string): ReportLogEntry[] {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length > SERVER_LOG_MAX_ENTRIES + 1) throw new ServerLogCollectionError('Server log response exceeded its entry limit')
  const entries: ReportLogEntry[] = []
  for (const line of lines) {
    let decodedRow: unknown
    try { decodedRow = JSON.parse(line) } catch {
      throw new ServerLogCollectionError('Server log response contained invalid row JSON')
    }
    const validatedRow = rowSchema.safeParse(decodedRow)
    if (!validatedRow.success) throw new ServerLogCollectionError('Server log response row was malformed')
    const row = validatedRow.data
    let raw: unknown
    try { raw = JSON.parse(row.raw) } catch {
      throw new ServerLogCollectionError('Server log entry contained invalid JSON')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ServerLogCollectionError('Server log response was malformed')
    const fields = raw as Record<string, unknown>
    // Text loggers use user=<id>; enforce a complete token, not a prefix or another user's row.
    const message = typeof fields.message === 'string' ? fields.message : ''
    const textIdentity = message.split(/[^A-Za-z0-9_]+/).includes(userId)
    const structuredIds = [fields.mentraUserId, fields.userId].filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (structuredIds.length ? structuredIds.some(value => value !== userId) : !textIdentity) continue
    const timestamp = Date.parse(row.dt.replace(' ', 'T') + (row.dt.endsWith('Z') ? '' : 'Z'))
    if (!Number.isFinite(timestamp)) throw new ServerLogCollectionError('Server log timestamp was malformed')
    entries.push({timestamp, level: typeof fields.level === 'string' ? fields.level : 'info', message: JSON.stringify(scrub(fields))})
  }
  const truncated = lines.length > SERVER_LOG_MAX_ENTRIES
  const bounded = entries.slice(0, SERVER_LOG_MAX_ENTRIES).reverse()
  if (truncated) bounded.push({timestamp: bounded.at(-1)?.timestamp ?? Date.now(), level: 'warn', message: `Server log collection retained the latest ${SERVER_LOG_MAX_ENTRIES} matching entries; earlier entries were omitted`})
  return bounded
}

export async function collectServerLogs(input: {source: 'cloud' | 'miniapp_server'; mentraUserId: string; createdAt: Date}, transport: typeof fetch = fetch): Promise<ReportLogEntry[]> {
  const username = process.env.BETTERSTACK_V2_USERNAME, password = process.env.BETTERSTACK_V2_PASSWORD
  if (!username || !password) throw new ServerLogCollectionError('Better Stack V2 query credentials are not configured')
  const host = process.env.BETTERSTACK_V2_HOST ?? 'https://eu-central-1a-connect.betterstackdata.com'
  const query = serverLogQuery(input.source, process.env.CLOUD_CORE_ENVIRONMENT ?? '', input.mentraUserId, input.createdAt)
  const signal = AbortSignal.timeout(15_000)
  let responseStarted = false
  try {
    const response = await transport(host, {method: 'POST', redirect: 'error', signal,
      headers: {'Content-Type': 'text/plain', Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`}, body: query})
    responseStarted = true
    if (!response.ok) throw new ServerLogCollectionError(`Better Stack V2 log query failed (HTTP ${response.status})`,
      response.status === 429 || response.status >= 500)
    if (!response.body) throw new ServerLogCollectionError('Better Stack V2 log query returned no response body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        size += item.value.byteLength
        if (size > SERVER_LOG_MAX_BYTES) throw new ServerLogCollectionError('Server log response exceeded 2 MiB')
        chunks.push(item.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    return parseServerLogs(Buffer.concat(chunks).toString('utf8'), input.mentraUserId)
  } catch (error) {
    if (error instanceof ServerLogCollectionError) throw error
    const timedOut = (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError')
      || (error instanceof Error && error.name === 'TimeoutError')
    // Only fixed categories escape to the report. Provider errors may contain
    // credentials, request URLs, SQL, or raw log entries.
    throw new ServerLogCollectionError(timedOut
      ? responseStarted ? 'Better Stack V2 log query timed out while reading the response' : 'Better Stack V2 log query timed out before receiving a response'
      : responseStarted ? 'Better Stack V2 log query response was interrupted' : 'Better Stack V2 log query transport failed before receiving a response', true)
  }
}
