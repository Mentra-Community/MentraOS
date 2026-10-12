import {Schema} from "mongoose"
import {registerModel} from "./register-model"

const schema = new Schema(
  {
    hostId: {type: String, required: true},
    incarnation: {type: String, required: true},
    incarnationGeneration: {type: Number, required: true},
    sequence: {type: Number, required: true},
    receivedAt: {type: Date, required: true},
    observedAt: {type: Date, required: true},
    snapshot: {type: Schema.Types.Mixed, required: true},
    frameworkHistory: {type: [Schema.Types.Mixed], default: []},
    frameworkStopReceipts: {type: [Schema.Types.Mixed], default: []},
    deploymentObservation: {type: Schema.Types.Mixed},
    deploymentGeneration: {type: Number, default: 0},
    deploymentSequence: {type: Number, default: 0},
    deploymentReceivedAt: {type: Date},
  },
  {collection: "test_host_state"},
)
schema.index({hostId: 1}, {unique: true})
export const TestHostStateModel = registerModel("TestHostState", schema)
