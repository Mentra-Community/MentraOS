import {randomUUID} from 'node:crypto'
import {PrRoutineCheckModel, PrRoutineCheckEventModel} from '../models/pr-routine-check.model'
import {testWriteConcern} from '../models/test-write-concern'
import type {PrRoutineCheck, PrRoutineCheckRow} from '../types/pr-routine-check.types'

export interface PrRoutineCheckRepository {
  get(gateId: string): Promise<PrRoutineCheckRow | null>
  insert(value: PrRoutineCheck, now: Date): Promise<void>
  claim(gateId: string, now: Date): Promise<PrRoutineCheckRow | null>
  save(row: PrRoutineCheckRow, value: PrRoutineCheck, nextAt: Date | null): Promise<boolean>
  wake(gateId: string, now: Date): Promise<void>
  due(now: Date): Promise<string[]>
  predecessors(prNumber: number, exceptGateId: string): Promise<string[]>
  eventsDue(now: Date): Promise<Array<{deliveryId: string; digest: string; control: unknown}>>
  eventSettled(deliveryId: string, nextAt?: Date): Promise<void>
  event(deliveryId: string, digest: string, gateId: string, control?: unknown): Promise<void>
}
const intakeWriteConcern = {...testWriteConcern, wtimeout: 2_000}
const read = (gateId: string) => PrRoutineCheckModel.findOne({gateId}).read('primary').readConcern('majority')
  .setOptions({timeoutMS: 10_000}).lean()
export const prRoutineCheckRepository: PrRoutineCheckRepository = {
  async get(gateId) {return await read(gateId) as PrRoutineCheckRow | null},
  async insert(payload, now) {
    try {await PrRoutineCheckModel.create([{gateId: payload.gateId, revision: 0, payload, nextAt: now}], {writeConcern: intakeWriteConcern, timeoutMS: 2_000})}
    catch (error) {if ((error as {code?: number}).code !== 11000) throw error}
  },
  async claim(gateId, now) {
    return await PrRoutineCheckModel.findOneAndUpdate({gateId, $or: [{lease: {$exists: false}}, {'lease.expiresAt': {$lte: now}}]},
      {$set: {lease: {id: randomUUID(), expiresAt: new Date(now.getTime() + 120_000)}}},
      {new: true, writeConcern: testWriteConcern, timeoutMS: 10_000}).lean() as PrRoutineCheckRow | null
  },
  async save(row, payload, nextAt) {
    const receipt = await PrRoutineCheckModel.updateOne({gateId: row.gateId, revision: row.revision, 'lease.id': row.lease!.id, 'lease.expiresAt': {$gt: new Date()}},
      {$set: {payload, ...(nextAt ? {nextAt} : {})}, $inc: {revision: 1}, $unset: {lease: 1, ...(!nextAt ? {nextAt: 1} : {})}}, {writeConcern: testWriteConcern, timeoutMS: 10_000})
    return receipt.modifiedCount === 1
  },
  async wake(gateId, now) {await PrRoutineCheckModel.updateOne({gateId}, {$min: {nextAt: now}}, {writeConcern: intakeWriteConcern, timeoutMS: 2_000})},
  async due(now) {return (await PrRoutineCheckModel.find({nextAt: {$exists: true, $lte: now}}).select({gateId: 1}).sort({nextAt: 1})
    .limit(20).read('primary').readConcern('majority').setOptions({timeoutMS: 10_000}).lean()).map(row => row.gateId)},
  async predecessors(prNumber, exceptGateId) {return (await PrRoutineCheckModel.find({'payload.context.number': prNumber,
    gateId: {$ne: exceptGateId}}).select({gateId: 1}).limit(100).read('primary').readConcern('majority').setOptions({timeoutMS: 2_000}).lean()).map(row => row.gateId)},
  async eventsDue(now) {return await PrRoutineCheckEventModel.find({control: {$exists: true}, processed: {$ne: true}, nextAt: {$lte: now}})
    .sort({nextAt: 1}).limit(20).read('primary').readConcern('majority').setOptions({timeoutMS: 5_000}).lean() as Array<{deliveryId: string; digest: string; control: unknown}>},
  async eventSettled(deliveryId, nextAt) {await PrRoutineCheckEventModel.updateOne({deliveryId}, {$set: nextAt ? {nextAt} : {processed: true}}, {writeConcern: testWriteConcern, timeoutMS: 5_000})},
  async event(deliveryId, digest, gateId, control) {
    try {await PrRoutineCheckEventModel.create([{deliveryId, digest, gateId, ...(control ? {control, nextAt: new Date()} : {})}], {writeConcern: intakeWriteConcern, timeoutMS: 2_000})}
    catch (error) {
      if ((error as {code?: number}).code !== 11000) throw error
      const retained = await PrRoutineCheckEventModel.findOne({deliveryId}).read('primary').readConcern('majority').setOptions({timeoutMS: 2_000}).lean()
      if (!retained || retained.digest !== digest || retained.gateId !== gateId) throw new Error('Webhook delivery identity conflicts')
    }
  },
}
