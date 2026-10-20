import {createHash} from 'node:crypto'
import {z} from 'zod'
import {TestHostStateModel} from '../models/test-host-state.model'
import {testWriteConcern} from '../models/test-write-concern'
import {laneControlInputSchema, laneControlRecordSchema, laneControlReceiptSchema,
  resourceControlInputSchema, resourceControlCommandSchema, resourceControlRecordSchema, resourceControlReceiptSchema,
  type LaneControlInput, type LaneControlView, type LaneControlRecord, type LaneControlsView,
  type ResourceControlInput, type ResourceControlRecord, type ResourceControlView, type ResourceControlsView} from '../types/lane-control.types'
import {resourceLifecycleSchema, type ResourceLifecycleSubject} from '../types/resource-lifecycle.types'
import {ResourceLifecycleService} from './resource-lifecycle.service'
import {requestInputDigest} from './test-request.service'
import {TestRunError} from './test-result-error'
import {laneRepairStatusSchema, type LaneRepairStatus, type LaneActivity} from '../types/lane-restoration.types'

type ControlRecord = LaneControlRecord | ResourceControlRecord
const recordsSchema = z.array(z.union([laneControlRecordSchema, resourceControlRecordSchema])).max(100)
export {laneControlExchangeSchema} from '../types/lane-control.types'
import {laneControlExchangeSchema} from '../types/lane-control.types'
export type LaneControlHost = {hostId: string; laneControlVersion?: number; laneControls?: unknown; resourceReservationVersion?: number;
  receivedAt: Date; observedAt: Date; snapshot: {laneControls?: unknown; resourceLifecycle?: unknown; restoration?: {attempts: LaneRepairStatus[]};
    lanes: Array<{id: string; dispatchMode: string; state?: string; activity?: LaneActivity}>}}
export interface LaneControlRepository {
  get(hostId: string): Promise<LaneControlHost | null>
  replace(hostId: string, version: number, records: ControlRecord[], resourceAuthority?: LaneControlHost): Promise<boolean>
}
export const laneControlRepository: LaneControlRepository = {
  async get(hostId) {
    return await TestHostStateModel.findOne({hostId}).select({hostId: 1, laneControls: 1, laneControlVersion: 1, resourceReservationVersion: 1,
      receivedAt: 1, observedAt: 1, 'snapshot.lanes.id': 1, 'snapshot.lanes.dispatchMode': 1, 'snapshot.lanes.state': 1, 'snapshot.lanes.activity': 1,
      'snapshot.restoration.attempts.executionId': 1, 'snapshot.restoration.attempts.interruptionId': 1,
      'snapshot.restoration.attempts.laneId': 1, 'snapshot.restoration.attempts.state': 1,
      'snapshot.restoration.attempts.current': 1, 'snapshot.restoration.attempts.startedAt': 1,
      'snapshot.restoration.attempts.finishedAt': 1, 'snapshot.restoration.attempts.haltDecisionId': 1,
      'snapshot.resourceLifecycle': 1, 'snapshot.laneControls': 1})
      .read('primary').readConcern('majority').setOptions({timeoutMS: 5000}).lean() as LaneControlHost | null
  },
  async replace(hostId, version, records, resourceAuthority) {
    const row = await TestHostStateModel.findOneAndUpdate({hostId, $or: [{laneControlVersion: version},
      ...(version === 0 ? [{laneControlVersion: {$exists: false}}] : [])],
      ...(resourceAuthority ? {resourceReservationVersion:resourceAuthority.resourceReservationVersion??{$exists:false},
        receivedAt:resourceAuthority.receivedAt,observedAt:resourceAuthority.observedAt,
        'snapshot.resourceLifecycle':resourceAuthority.snapshot.resourceLifecycle,
        'snapshot.laneControls':resourceAuthority.snapshot.laneControls}: {})},
      {$set: {laneControls: records}, $inc: {laneControlVersion: 1}}, {new: true, writeConcern: testWriteConcern})
      .select({hostId: 1}).setOptions({timeoutMS: 5000}).lean()
    return Boolean(row)
  },
}
const supportsRepairReopen = (host: LaneControlHost) =>
  (host.snapshot.laneControls as {reopenRepair?: unknown} | undefined)?.reopenRepair === true
const operatorIdentity = (operator: string) => createHash('sha256').update(`admin-lane:${operator}`).digest('hex')
const activeReservation = (row: ControlRecord) => row.receipt?.result.status === 'accepted' &&
  row.receipt.result.reservation && ['waiting', 'granted', 'returning'].includes(row.receipt.result.reservation.state)
const activeCheck = (row: ControlRecord) => 'subject' in row.command && row.receipt?.result.status === 'accepted' &&
  'check' in row.receipt.result && row.receipt.result.check && row.receipt.result.check.state !== 'settled'
const delivered = (row: ControlRecord) => row.receipt !== undefined
const isLane = (row: ControlRecord): row is LaneControlRecord => 'laneId' in row.command
const isResource = (row: ControlRecord): row is ResourceControlRecord => 'subject' in row.command
const view = (row: LaneControlRecord) => ({operationId: row.command.operationId, hostId: row.command.hostId,
  laneId: row.command.laneId, action: row.command.action, expiresAt: row.command.expiresAt,
  ...(row.receipt ? {receipt: row.receipt} : {})})
const resourceView = (row: ResourceControlRecord): ResourceControlView => ({operationId: row.command.operationId,
  hostId: row.command.hostId, subject: row.command.subject, action: row.command.action, expiresAt: row.command.expiresAt,
  ...(row.receipt ? {receipt: row.receipt} : {})})
const fresh = (host: LaneControlHost, now: number) => [host.receivedAt, host.observedAt].every(at =>
  Number.isFinite(at?.getTime()) && at.getTime() <= now + 5000 && now - at.getTime() <= 120000)

/** Delivery custody only. Every lane effect and reservation belongs to the local controller. */
export class LaneControlsService {
  constructor(private rows: LaneControlRepository = laneControlRepository, private now = Date.now,
    private resources: Pick<ResourceLifecycleService, 'detail'> = new ResourceLifecycleService()) {}
  private async update<T>(hostId: string, change: (host: LaneControlHost, records: ControlRecord[]) => {records: ControlRecord[]; result: T; resourceAuthority?: boolean} | Promise<{records: ControlRecord[]; result: T; resourceAuthority?: boolean}>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const host = await this.rows.get(hostId)
      if (!host) throw new TestRunError(404, 'Testing computer was not found')
      const records = reconcileControls(recordsSchema.parse(host.laneControls ?? [])), next = await change(host, records)
      if (requestInputDigest(records) === requestInputDigest(next.records) ||
        await this.rows.replace(hostId, host.laneControlVersion ?? 0, next.records, next.resourceAuthority?host:undefined)) return next.result
    }
    throw new TestRunError(409, 'Lane controls changed; retry the same request')
  }
  async list(hostId: string, operator: string): Promise<LaneControlsView> {
    const host = await this.rows.get(hostId)
    if (!host) throw new TestRunError(404, 'Testing computer was not found')
    return {enabled: Boolean(host.snapshot.laneControls), reopenRepair: supportsRepairReopen(host), fresh: fresh(host, this.now()), observedAt: host.observedAt.toISOString(), controls: reconcileControls(recordsSchema.parse(host.laneControls ?? [])).filter(isLane)
      .filter(row => row.command.operatorId === operatorIdentity(operator)).map(view)}
  }
  private currentResource(host: LaneControlHost, subject: {resourceId: string; subjectGeneration: number}) {
    const lifecycle = resourceLifecycleSchema.safeParse(host.snapshot.resourceLifecycle), values = lifecycle.success
      ? lifecycle.data.subjects.filter(value => value.subject.id === subject.resourceId && value.subject.authorityHostId === host.hostId) : [],
      actual = values.length === 1 ? values[0] : undefined, at = Date.parse(actual?.observedAt ?? '');
    return actual?.current && actual.generation === subject.subjectGeneration && Number.isFinite(at) && at <= this.now() + 5000 &&
      this.now() - at <= 120_000 && fresh(host, this.now()) ? actual : undefined
  }
  async listResource(resourceId: string, operator: string): Promise<ResourceControlsView> {
    const {subject} = await this.resources.detail(resourceId), host = await this.rows.get(subject.subject.authorityHostId)
    if (!host) throw new TestRunError(404, 'Resource authority was not found')
    const key = {resourceId, subjectGeneration: subject.generation}, actual = this.currentResource(host, key)
    return {enabled: (host.snapshot.laneControls as {resourceControls?: unknown} | undefined)?.resourceControls === true,
      fresh: Boolean(actual && subject.current), observedAt: actual?.observedAt ?? host.observedAt.toISOString(), subject: key,
      controls: reconcileControls(recordsSchema.parse(host.laneControls ?? [])).filter(isResource)
        .filter(row => row.command.operatorId === operatorIdentity(operator) && row.command.subject.resourceId === resourceId).map(resourceView)}
  }
  private async submitResource(value: unknown, operator: string, operatorLabel?: string) {
    const input = resourceControlInputSchema.parse(value), operatorId = operatorIdentity(operator)
    // Exact retained identity remains observable after expiry/currentness changes; it cannot perform a new effect.
    const original = await this.rows.get(input.hostId), old = original && recordsSchema.parse(original.laneControls ?? [])
      .find(row => row.command.operationId === input.operationId)
    if (old) {
      if (!isResource(old) || old.command.operatorId !== operatorId ||
        requestInputDigest((({operatorId: _, ...body}) => body)(old.command)) !== requestInputDigest(input))
        throw new TestRunError(409, 'Resource control request identity changed')
      return resourceView(old)
    }
    return this.update(input.hostId, async (host, records) => {
      const existing = records.find(row => row.command.operationId === input.operationId)
      if (existing) {
        if (!isResource(existing) || existing.command.operatorId !== operatorId ||
          requestInputDigest((({operatorId: _, ...body}) => body)(existing.command)) !== requestInputDigest(input))
          throw new TestRunError(409, 'Resource control request identity changed')
        return {records, result: resourceView(existing)}
      }
      const canonical = (await this.resources.detail(input.subject.resourceId)).subject
      if (canonical.subject.authorityHostId !== input.hostId || canonical.generation !== input.subject.subjectGeneration)
        throw new TestRunError(409, 'Resource authority or generation changed; refresh its status')
      if (input.expiresAt <= this.now() || input.expiresAt > this.now() + 125_000)
        throw new TestRunError(409, 'This action expired; refresh and choose a new action')
      const subject = this.currentResource(host, input.subject)
      if (!subject || !canonical.current || canonical.receivedAt && Date.parse(canonical.receivedAt)!==host.receivedAt.getTime() ||
        (host.snapshot.laneControls as {resourceControls?: unknown} | undefined)?.resourceControls !== true)
        throw new TestRunError(409, 'Refresh resource status; its controller is not accepting current resource controls')
      if (!subject.supportedActions.includes(input.action) || !canonical.supportedActions.includes(input.action))
        throw new TestRunError(409, 'This resource does not currently support that action')
      if (subject.owner?.generation === null || canonical.owner?.generation === null)
        throw new TestRunError(409, 'Resource owner identity is unknown; retain custody')
      const same = records.filter(isResource).filter(row => row.command.subject.resourceId === input.subject.resourceId)
      if (same.some(row => !delivered(row))) throw new TestRunError(409, 'A resource control is awaiting its controller receipt')
      const owned = same.filter(row => row.command.operatorId === operatorId), reservation = currentResourceReservation(owned)
      if (input.action === 'reserve' && reservation) throw new TestRunError(409, 'You already have a reservation on this resource')
      if (input.action === 'release' && (!reservation || !['waiting', 'granted'].includes(reservation.state) ||
        reservation.id !== input.reservation!.id || reservation.generation !== input.reservation!.generation))
        throw new TestRunError(409, 'Release requires your current waiting or granted resource reservation')
      const row = resourceControlRecordSchema.parse({command: {...input, operatorId}, ...(operatorLabel && input.action === 'reserve' ? {operatorLabel} : {})}),
        unresolved = records.filter(row => !delivered(row) || activeReservation(row) || activeCheck(row)),
        returnSlots = pendingReturnSlots([...records, row]), space = Math.max(0, 99 - unresolved.length - returnSlots),
        recent = space ? records.filter(row => delivered(row) && !activeReservation(row) && !activeCheck(row)).slice(-space) : [],
        retained = records.filter(row => unresolved.includes(row) || recent.includes(row));
      if (retained.length + 1 + returnSlots > 100) throw new TestRunError(409, 'Resource controls are busy; active reservations retain space for return')
      return {records: [...retained, row], result: resourceView(row), resourceAuthority:true}
    })
  }
  async submit(value: LaneControlInput, operator: string, operatorLabel?: string): Promise<LaneControlView>
  async submit(value: ResourceControlInput, operator: string, operatorLabel?: string): Promise<ResourceControlView>
  async submit(value: unknown, operator: string, operatorLabel?: string): Promise<LaneControlView | ResourceControlView>
  async submit(value: unknown, operator: string, operatorLabel?: string) {
    if (value && typeof value === 'object' && 'subject' in value) return this.submitResource(value, operator, operatorLabel)
    const input = laneControlInputSchema.parse(value)
    return this.update(input.hostId, (host, records) => {
      const operatorId = operatorIdentity(operator), existing = records.find(row => row.command.operationId === input.operationId)
      if (existing) {
        if (!isLane(existing)) throw new TestRunError(409, 'Lane control request identity changed')
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
      const row = laneControlRecordSchema.parse({command: {...input, operatorId},
        ...(input.action === 'reserve' && operatorLabel ? {operatorLabel} : {})})
      const returnSlots = pendingReturnSlots([...records, row])
      const unresolved = records.filter(row => !delivered(row) || activeReservation(row) || activeCheck(row))
      const remaining = Math.max(0, 99 - unresolved.length - returnSlots)
      const recent = remaining ? records.filter(row => delivered(row) && !activeReservation(row) && !activeCheck(row)).slice(-remaining) : []
      const retained = records.filter(row => unresolved.includes(row) || recent.includes(row))
      if (retained.length + 1 + returnSlots > 100) throw new TestRunError(409, 'Lane controls are busy; current reservations retain space for release')
      if (retained.filter(isLane).some(row => row.command.laneId === input.laneId && !delivered(row)))
        throw new TestRunError(409, 'A lane control is awaiting its controller receipt')
      const owned = retained.filter(isLane).filter(row => row.command.operatorId === operatorId && row.command.laneId === input.laneId)
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
        if (receipt.hostId !== hostId || receipt.inputSha256 !== requestInputDigest(row.command) ||
          (isLane(row) ? !('laneId' in receipt) || receipt.laneId !== row.command.laneId :
            !('subject' in receipt) || requestInputDigest(receipt.subject) !== requestInputDigest(row.command.subject)))
          throw new TestRunError(409, 'Lane control receipt differs from its retained command')
        return isLane(row) ? {...row, receipt: reconcileReceipt(row, laneControlReceiptSchema.parse(receipt))} :
          {...row, receipt: reconcileResourceReceipt(row, resourceControlReceiptSchema.parse(receipt))}
      })
      // A terminal record may have left the bounded delivery history while its last acknowledgement was in flight.
      // Forgotten receipts cannot perform an operation; retained commands remain the only source of effects.
      if (exchange.receipts.some(receipt => receipt.hostId !== hostId))
        throw new TestRunError(409, 'Lane control receipt names another computer')
      const reconciled = reconcileControls(next)
      return {records: reconciled, result: {schemaVersion: 1 as const,
        commands: reconciled.filter(row => !delivered(row) || activeReservation(row) || activeCheck(row)).map(row => row.command)}}
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

function currentResourceReservation(records: ResourceControlRecord[]) {
  const latest = new Map<string, NonNullable<Extract<NonNullable<ResourceControlRecord['receipt']>['result'], {status: 'accepted'}>['reservation']>>()
  const rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
  for (const row of records) {
    const value = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation : undefined
    if (value && (!latest.has(value.id) || rank[value.state] >= rank[latest.get(value.id)!.state])) latest.set(value.id, value)
  }
  return [...latest.values()].find(value => ['waiting', 'granted', 'returning'].includes(value.state))
}
function reconcileControls(records: ControlRecord[]): ControlRecord[] {
  const lanes = reconcileReservations(records.filter(isLane)), rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3},
    latest = new Map<string, NonNullable<Extract<NonNullable<ResourceControlRecord['receipt']>['result'], {status: 'accepted'}>['reservation']>>()
  for (const row of records.filter(isResource)) {
    const value = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation : undefined
    if (value && (!latest.has(value.id) || rank[value.state] >= rank[latest.get(value.id)!.state])) latest.set(value.id, value)
  }
  return records.map(row => {
    if (isLane(row)) return lanes.find(value => value.command.operationId === row.command.operationId)!
    const reservation = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation : undefined
    return reservation && row.receipt?.result.status === 'accepted' ? {...row,
      receipt: {...row.receipt, result: {...row.receipt.result, reservation: latest.get(reservation.id)!}}} : row
  })
}
function reconcileResourceReceipt(row: ResourceControlRecord, receipt: NonNullable<ResourceControlRecord['receipt']>) {
  const result = receipt.result, prior = row.receipt, input = row.command
  if (result.status === 'accepted') {
    const choices = [result.reservation, result.check, result.resource].filter(Boolean)
    const matches = choices.length === 1 && (input.action === 'reserve' || input.action === 'release' ?
      result.reservation?.resourceId === input.subject.resourceId && (input.action === 'reserve' ? result.reservation.purpose === input.purpose :
        result.reservation.id === input.reservation!.id && result.reservation.generation === input.reservation!.generation) : input.action === 'check' ?
      result.check?.resourceId === input.subject.resourceId && result.check.operationId === input.operationId &&
        result.check.generation >= input.subject.subjectGeneration : result.resource?.resourceId === input.subject.resourceId &&
          result.resource.generation >= input.subject.subjectGeneration)
    if (!matches) throw new TestRunError(409, 'Resource control receipt does not match its requested action')
  }
  if (!prior) return receipt
  if (prior.completedAt !== receipt.completedAt || prior.result.status !== result.status)
    throw new TestRunError(409, 'Resource control receipt changed its original decision')
  if (result.status === 'refused' || prior.result.status !== 'accepted') {
    if (requestInputDigest(prior) !== requestInputDigest(receipt)) throw new TestRunError(409, 'Resource control refusal changed')
    return prior
  }
  if (result.reservation) {
    const old = prior.result.reservation, rank = {waiting: 0, granted: 1, returning: 2, released: 3, cancelled: 3}
    if (!old || old.id !== result.reservation.id || old.resourceId !== result.reservation.resourceId ||
      old.purpose !== result.reservation.purpose || old.requestedAt !== result.reservation.requestedAt ||
      old.generation !== 0 && old.generation !== result.reservation.generation)
      throw new TestRunError(409, 'Resource reservation identity changed')
    if (rank[result.reservation.state] < rank[old.state]) return prior
    if (rank[old.state] === 3 && result.reservation.state !== old.state) throw new TestRunError(409, 'Terminal resource reservation changed')
    return receipt
  }
  if (result.check) {
    const old = prior.result.check
    if (!old || old.operationId !== result.check.operationId || old.resourceId !== result.check.resourceId || old.generation !== result.check.generation)
      throw new TestRunError(409, 'Resource check identity changed')
    const rank = {intended: 0, active: 1, unknown: 2, settled: 3}
    return rank[result.check.state] >= rank[old.state] ? receipt : prior
  }
  if (requestInputDigest(result) !== requestInputDigest(prior.result)) throw new TestRunError(409, 'Resource control decision changed')
  return prior
}

/** Admission reserves one delivery slot for every reservation that still needs its eventual return command. */
function pendingReturnSlots(records: ControlRecord[]) {
  return records.filter(row => row.command.action === 'reserve' && (!row.receipt ||
    row.receipt.result.status === 'accepted' && row.receipt.result.reservation && ['waiting', 'granted'].includes(row.receipt.result.reservation.state)))
    .filter(row => {
      const id = row.receipt?.result.status === 'accepted' ? row.receipt.result.reservation?.id : undefined
      return !id || !records.some(other => other.command.action === 'release' && other.command.reservation?.id === id &&
        (!other.receipt || other.receipt.result.status === 'accepted'))
    }).length
}
