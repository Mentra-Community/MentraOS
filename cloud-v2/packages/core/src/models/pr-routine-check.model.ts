import {Schema} from 'mongoose'
import {registerModel} from './register-model'

/** One check owner per repository/head; this is reporting state, not a device queue. */
const schema = new Schema({
  gateId: {type: String, required: true, unique: true},
  revision: {type: Number, required: true},
  payload: {type: Schema.Types.Mixed, required: true},
  nextAt: {type: Date},
  lease: {type: Schema.Types.Mixed},
}, {collection: 'pr_routine_checks', timestamps: true})
schema.index({nextAt: 1})
export const PrRoutineCheckModel = registerModel('PrRoutineCheck', schema)

const events = new Schema({
  deliveryId: {type: String, required: true, unique: true},
  digest: {type: String, required: true},
  gateId: {type: String, required: true},
  control: {type: Schema.Types.Mixed},
  nextAt: {type: Date},
  processed: {type: Boolean},
}, {collection: 'pr_routine_check_events', timestamps: true})
events.index({processed: 1, nextAt: 1})
export const PrRoutineCheckEventModel = registerModel('PrRoutineCheckEvent', events)
