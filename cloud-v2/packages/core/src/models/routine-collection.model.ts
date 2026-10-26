import {Schema} from 'mongoose';
import {registerModel} from './register-model';

/** One immutable source catalog projection; exact run definitions have their own enrollment. */
const schema = new Schema({
  commit: {type: String, required: true, immutable: true},
  version: {type: Number, required: true, immutable: true},
  manifestSha256: {type: String, required: true, immutable: true},
  // Retained publications read their original R2 details. New metadata-only
  // collections are bounded by the existing JSON ingress limit and stored here.
  detail: {type: Schema.Types.Mixed, immutable: true},
  catalog: {type: Schema.Types.Mixed, immutable: true},
  members: {type: [{
    _id: false,
    routineId: {type: String, required: true},
    platform: {type: String, required: true},
    definitionSha256: {type: String, required: true},
  }], required: true, immutable: true},
}, {collection: 'routine_collections', timestamps: true});
schema.index({commit: 1}, {unique: true});
schema.index({version: -1}, {unique: true});
export const RoutineCollectionModel = registerModel('RoutineCollection', schema);
