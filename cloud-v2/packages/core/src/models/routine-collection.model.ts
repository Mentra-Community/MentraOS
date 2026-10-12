import {Schema} from 'mongoose';
import {registerModel} from './register-model';

/** One immutable publication receipt, not another catalog or a deployment queue. */
const schema = new Schema({
  commit: {type: String, required: true, immutable: true},
  version: {type: Number, required: true, immutable: true},
  manifestSha256: {type: String, required: true, immutable: true},
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
