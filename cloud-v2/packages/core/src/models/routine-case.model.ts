import {Schema} from 'mongoose'
import {registerModel} from './register-model'

/** Sole cause/occurrence/claim authority. No automatic executor inbox is created. */
const cases = new Schema({caseId: {type: String, required: true, unique: true}, version: {type: Number, required: true},
  revision: {type: Number, required: true}, generation: {type: Number, required: true},
  rootKeys: {type: [String], required: true}, payload: {type: Schema.Types.Mixed, required: true},
}, {collection: 'routine_cases', strict: true})
cases.index({rootKeys: 1}, {unique: true})
cases.index({'payload.intendedFixes.repository': 1, 'payload.intendedFixes.number': 1})
export const RoutineCaseModel = registerModel('RoutineCase', cases)

/** Queryable revision/actor history only; never cause, claim or execution authority. */
const activity = new Schema({caseId: {type: String, required: true}, revision: {type: Number, required: true},
  mutationId: {type: String, required: true}, digest: {type: String, required: true}, actor: {type: String, required: true},
  at: {type: String, required: true}, kind: {type: String, required: true}, changed: {type: [String], required: true},
  detail: {type: new Schema({key: {type: String, required: true}, sha256: {type: String, required: true},
    sizeBytes: {type: Number, required: true}}, {_id: false, strict: true}), required: true},
}, {collection: 'routine_case_activity', strict: true})
activity.index({caseId: 1, revision: 1}, {unique: true})
activity.index({mutationId: 1}, {unique: true})
export const RoutineCaseActivityModel = registerModel('RoutineCaseActivity', activity)
