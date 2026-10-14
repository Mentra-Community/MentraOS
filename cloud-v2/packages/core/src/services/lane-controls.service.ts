import {createHash} from 'node:crypto'
import {z} from 'zod'
import {TestHostStateModel} from '../models/test-host-state.model'
import {testWriteConcern} from '../models/test-write-concern'
import {laneControlInputSchema, laneControlRecordSchema, laneControlReceiptSchema,
  type LaneControlRecord, type LaneControlsView} from '../types/lane-control.types'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {laneRepairStatusSchema, type LaneRepairStatus, type LaneActivity} from '../types/lane-restoration.types'

const recordsSchema = z.array(laneControlRecordSchema).max(100)
export const laneControlExchangeSchema = z.object({schemaVersion: z.literal(1),
  receipts: z.array(laneControlReceiptSchema).max(100), reopenRepair: z.literal(true).optional()}).strict()
export type LaneControlHost = {hostId: string; laneControlVersion?: number; laneControls?: unknown;
  receivedAt: Date; observedAt: Date; snapshot: {laneControls?: unknown; restoration?: {attempts: LaneRepairStatus[]};
    lanes: Array<{id: string; dispatchMode: string; state?: string; activity?: LaneActivity}>}}
export interface LaneControlRepository {
  get(hostId: string): Promise<LaneControlHost | null>
  replace(hostId: string, version: number, records: LaneControlRecord[]): Promise<boolean>
}
const repository: LaneControlRepository = {
  async get(hostId) {
    return await TestHostStateModel.findOne({hostId}).select({hostId: 1, laneControls: 1, laneControlVersion: 1,
      receivedAt: 1, observedAt: 1, 'snapshot.lanes.id': 1, 'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1,
      'snapshot.restoration.attempts.executionId': 1, 'snapshot.restoration.attempts.interruptionId': 1,
      'snapshot.restoration.attempts.laneId': 1, 'snapshot.restoration.attempts.state': 1,
      'snapshot.restoration.attempts.current': 1, 'snapshot.restoration.attempts.startedAt': 1,
      'snapshot.restoration.attempts.finishedAt': 1, 'snapshot.restoration.attempts.haltDecisionId': 1, 'snapshot.laneControls': 1})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() as LaneControlHost | null
  },
  async replace(hostId, version, records) {
    const row = await TestHostStateModel.findOneAndUpdate({hostId, $or: [{laneControlVersion: version},
      ...(version === 0 ? [{laneControlVersion: {$exists: false}}] : [])]},
      {$set: {laneControls: records}, $inc: {laneControlVersion: 1}}, {new: true, writeConcern: testWriteConcern})
      .select({hostId: 1}).setOptions({timeoutMS: 5000}).lean()
    return Boolean(row)
  },
}
const supportsRepairReopen = (host: LaneControlHost) =>
  (host.snapshot.laneControls as {reopenRepair?: unknown} | undefined)?.reopenRepair === true
const operatorIdentity = (operator: string) => createHash('sha256').update(`admin-lane:${operator}`).digest('hex')
const activeReservation = (row: LaneControlRecord) => row.receipt?.result.status === 'accepted' &&
  row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state)
const delivered = (row: LaneControlRecord) => row.receipt !== undefined
const view = (row: LaneControlRecord) => ({operationId: row.command.operationId, hostId: row.command.hostId,
  laneId: row.command.laneId, action: row.command.action, expiresAt: row.command.expiresAt,
  ...(row.receipt ? {receipt: row.receipt} : {})})
const fresh = (host: LaneControlHost, now: number) => [host.receivedAt, host.observedAt].every(at =>
  Number.isFinite(at?.getTime()) && at.getTime() <= now + 5000 && now - at.getTime() <= 120000)

/** Delivery custody only. Every lane effect and reservation belongs to the local controller. */
export class LaneControlsService {
  constructor(private rows: LaneControlRepository = repository, private now = Date.now) {}
  private async update<T>(hostId: string, change: (host: LaneControlHost, records: LaneControlRecord[]) => {records: LaneControlRecord[]; result: T}): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = await this.rows.get(hostId)
      if (!host) throw new TestRunError(404, 'Testing computer was not found')
      const records = reconcileReservations(recordsSchema.parse(host.laneControls ?? [])), next = change(host, records)
      if (requestInputDigest(records) === requestInputDigest(next.records) ||
        await this.rows.replace(hostId, host.laneControlVersion ?? 0, next.records)) return next.result
    }
    throw new TestRunError(409, 'Lane controls changed; retry the same request')
  }
  async list(hostId: string, operator: string): Promise<LaneControlsView> {
    const host = await this.rows.get(hostId)
    if (!host) throw new TestRunError(404, 'Testing computer was not found')
    return {enabled: Boolean(host.snapshot.laneControls), reopenRepair: supportsRepairReopen(host), fresh: fresh(host, this.now()), observedAt: host.observedAt.toISOString(), controls: reconcileReservations(recordsSchema.parse(host.laneControls ?? []))
      .filter(row => row.command.operatorId === operatorIdentity(operator)).map(view)}
  }
  async submit(value: unknown, operator: string) {
    const input = laneControlInputSchema.parse(value)
    return this.update(input.hostId, (host, records) => {
      const operatorId = operatorIdentity(operator), existing = records.find(row => row.command.operationId === input.operationId)
      if (existing) {
        const {operatorId: originalOperator, ...original} = existing.command
        if (originalOperator !== operatorId || requestInputDigest(original) !== requestInputDigest(input))
          throw new TestRunError(409, 'Lane control request identity changed')
        return {records, result: view(existing)}
      }
      if (input.expiresAt <= this.now() || input.expiresAt > this.now() + 125000)
        throw new TestRunError(409, 'This action expired; refresh and choose a new action')
      const lane = host.snapshot.lanes.find(lane => lane.id === input.laneId)
      if (!lane) throw new TestRunError(404, 'Lane was not found on this computer')
      if (!fresh(host, this.now()) || !host.snapshot.laneControls)
        throw new TestRunError(409, 'Refresh lane status; this controller is not currently accepting dashboard controls')
      if (input.action === 'reopen-repair') {
        if (!supportsRepairReopen(host)) throw new TestRunError(409, 'This controller has not enabled recovery retries')
        const attempts = host.snapshot.restoration?.attempts.filter(row => row.laneId === lane.id &&
          row.executionId === lane.activity?.owner.id) ?? []
        const attempt = attempts.length === 1 ? laneRepairStatusSchema.safeParse(attempts[0]) : null
        if (lane.state !== 'out-of-service' || lane.activity?.owner.kind !== 'fixer' || !attempt?.success ||
          attempt.data.state !== 'halted' || attempt.data.current ||
          attempt.data.interruptionId !== input.repair!.interruptionId ||
          attempt.data.haltDecisionId !== input.repair!.expectedHaltDecisionId)
          throw new TestRunError(409, 'Recovery changed; refresh and retry only the current halted repair')
      }
      if (input.action === 'reserve' && lane.dispatchMode === 'paused')
        throw new TestRunError(409, 'Resume scheduling before reserving this lane')
      const row: LaneControlRecord = {command: {...input, operatorId}}
      const returnSlots = pendingReturnSlots([...records, row])
      const unresolved = records.filter(row => !delivered(row) || activeReservation(row))
      const remaining = Math.max(0, 99 - unresolved.length - returnSlots)
      const recent = remaining ? records.filter(row => delivered(row) && !activeReservation(row)).slice(-remaining) : []
      const retained = records.filter(row => unresolved.includes(row) || recent.includes(row))
      if (retained.length + 1 + returnSlots > 100) throw new TestRunError(409, 'Lane controls are busy; current reservations retain space for release')
      if (retained.some(row => row.command.laneId === input.laneId && !delivered(row)))
        throw new TestRunError(409, 'A lane control is awaiting its controller receipt')
      const owned = retained.filter(row => row.command.operatorId === operatorId && row.command.laneId === input.laneId)
      const reservations = owned.flatMap(row => row.receipt?.result.status === 'accepted' && row.receipt.result.reservation ? [row.receipt.result.reservation] : [])
      const actual = reservations.filter(value => ['waiting', 'granted', 'returning'].includes(value.state))
        .find(value => !reservations.some(other => other.id === value.id && (['released', 'cancelled'].includes(other.state) ||
          value.state !== 'returning' && other.state === 'returning')))
      if (input.action === 'reserve' && actual) throw new TestRunError(409, 'You already have a reservation on this lane')
      if (input.action === 'release') {
        if (!actual || actual.id !== input.reservation?.id || actual.generation !== input.reservation.generation ||
            !['waiting', 'granted'].includes(actual.state))
          throw new TestRunError(409, 'Release requires your current waiting or granted reservation; refresh its status')
      }
      return {records: [...retained, row], result: view(row)}
    })
  }
  async exchange(hostId: string, value: unknown) {
    const exchange = laneControlExchangeSchema.parse(value)
    return this.update(hostId, (_host, records) => {
      const next = records.map(row => {
        const receipt = exchange.receipts.find(receipt => receipt.operationId === row.command.operationId)
        if (!receipt) return row
        if (receipt.hostId !== hostId || receipt.laneId !== row.command.laneId || receipt.inputSha256 !== requestInputDigest(row.command))
          throw new TestRunError(409, 'Lane control receipt differs from its retained command')
        return {...row, receipt: reconcileReceipt(row, receipt)}
      })
      // A terminal record may have left the bounded delivery history while its last acknowledgement was in flight.
      // Forgotten receipts cannot perform an operation; retained commands remain the only source of effects.
      if (exchange.receipts.some(receipt => receipt.hostId !== hostId))
        throw new TestRunError(409, 'Lane control receipt names another computer')
      const reconciled = reconcileReservations(next)
      return {records: reconciled, result: {schemaVersion: 1 as const,
        commands: reconciled.filter(row => !delivered(row) || activeReservation(row)).map(row => row.command)}}
    })
  }
}

function reconcileReceipt(row: LaneControlRecord, receipt: NonNullable<LaneControlRecord['receipt']>) {
  const result = receipt.result, prior = row.receipt
  if (result.status === 'accepted') {
    const modeAction = row.command.action === 'pause' || row.command.action === 'resume'
    const repairAction = row.command.action === 'reopen-repair'
    const matches = modeAction
      ? result.mode === (row.command.action === 'pause' ? 'paused' : 'automatic') && !result.reservation && !result.repair
      : repairAction
        ? !result.mode && !result.reservation && result.repair?.interruptionId === row.command.repair!.interruptionId &&
          result.repair.laneId === row.command.laneId
        : !result.mode && !result.repair && result.reservation?.laneId === row.command.laneId &&
          (row.command.action === 'reserve' ? result.reservation.purpose === row.command.purpose
            : result.reservation.id === row.command.reservation!.id && result.reservation.generation === row.command.reservation!.generation)
    if (!matches)
      throw new TestRunError(409, 'Lane control receipt does not match its requested action')
  }
  if (!prior) return receipt
  if (receipt.completedAt !== prior.completedAt || result.status !== prior.result.status)
    throw new TestRunError(409, 'Lane control receipt changed its original decision')
  if (result.status === 'refused' || !('reservation' in result) || !result.reservation) {
    if (requestInputDigest(result) !== requestInputDigest(prior.result))
      throw new TestRunError(409, 'Lane control receipt changed its original decision')
    return prior
  }
  const old = prior.result.status === 'accepted' ? prior.result.reservation : undefined
  if (!old || old.id !== result.reservation.id || old.laneId !== result.reservation.laneId ||
    old.purpose !== result.reservation.purpose || old.requestedAt !== result.reservation.requestedAt ||
    old.generation !== 0 && old.generation !== result.reservation.generation)
    throw new TestRunError(409, 'Lane control receipt changed its reservation identity')
  const rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
  if (rank[result.reservation.state] < rank[old.state]) return prior
  if (rank[old.state] === 3 && result.reservation.state !== old.state)
    throw new TestRunError(409, 'Lane control receipt changed its terminal reservation')
  return receipt
}

/** One reservation can appear in both request and return receipts; retain its latest controller observation in both. */
function reconcileReservations(records: LaneControlRecord[]): LaneControlRecord[] {
  const rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
  const latest = new Map<string, NonNullable<Extract<NonNullable<LaneControlRecord['receipt']>['result'], {status: 'accepted'}>['reservation']>>()
  for (const row of records) {
    const value = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation : undefined
    if (value && (!latest.has(value.id) || rank[value.state] >= rank[latest.get(value.id)!.state])) latest.set(value.id, value)
  }
  return records.map(row => {
    const receipt = row.receipt, reservation = receipt?.result.status === 'accepted' ? receipt.result.reservation : undefined
    return reservation && receipt?.result.status === 'accepted'
      ? {...row, receipt: {...receipt, result: {...receipt.result, reservation: latest.get(reservation.id)!}}} : row
  })
}

/** Admission reserves one delivery slot for every reservation that still needs its eventual return command. */
function pendingReturnSlots(records: LaneControlRecord[]) {
  return records.filter(row => row.command.action === 'reserve' && (!row.receipt ||
    row.receipt.result.status === 'accepted' && row.receipt.result.reservation && ['waiting', 'granted'].includes(row.receipt.result.reservation.state)))
    .filter(row => {
      const id = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation?.id : undefined
      return !id || !records.some(other => other.command.action === 'release' && other.command.reservation?.id === id &&
        (!other.receipt || other.receipt.result.status === 'accepted'))
    }).length
}
