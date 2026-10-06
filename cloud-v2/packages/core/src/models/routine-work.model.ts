import {Schema} from 'mongoose'
import {registerModel} from './register-model'

/** Delivery receipts only. The machine authoring API owns jobs, attempts and hardware custody. */
const schema = new Schema(
  {
    workId: {type: String, required: true, unique: true},
    inputSha256: {type: String, required: true, immutable: true},
    requestSha256: {type: String, required: true, immutable: true},
    request: {type: Schema.Types.Mixed, required: true, immutable: true},
    work: {type: Schema.Types.Mixed, required: true, immutable: true},
    hostId: {type: String, required: true, immutable: true},
    acceptance: {type: Schema.Types.Mixed},
    status: {type: Schema.Types.Mixed},
    statusReceipts: {type: [{_id: false, eventId: String, sequence: Number, sha256: String}], default: []},
    reporting: {type: Schema.Types.Mixed},
  },
  {collection: 'routine_work_deliveries', timestamps: true},
)
schema.index({hostId: 1, createdAt: 1, workId: 1})
schema.index({'reporting.nextProgressAt': 1})
export const RoutineWorkModel = registerModel('RoutineWorkDelivery', schema)
