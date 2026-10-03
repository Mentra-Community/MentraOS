import {z} from "zod";
import {TestHostStateModel} from "../models/test-host-state.model";
import {testWriteConcern} from "../models/test-write-concern";
import {frameworkIdentitySchema} from "../types/framework-request.types";
import {routinePlatformSchema} from "../types/routine-definition.types";
import {TestRunError} from "./test-result-error";
const resource = z.object({id: frameworkIdentitySchema, kind: z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]), laneId: frameworkIdentitySchema.optional()}).strict();
export const hostStateSchema = z.object({hostId: frameworkIdentitySchema, incarnation: frameworkIdentitySchema,
  sequence: z.number().int().nonnegative().safe(), observedAt: z.string().datetime({offset: true}),
  lanes: z.array(z.object({id: frameworkIdentitySchema, platform: routinePlatformSchema,
    dispatchMode: z.enum(["automatic", "authoring", "paused"]),
    state: z.enum(["idle", "running", "reserved", "in-repair", "out-of-service", "offline"]),
    resources: z.array(resource)}).strict()).max(100)}).strict();
export type TestHostState = z.infer<typeof hostStateSchema>;
export class TestHostStateService {
  async report(input: unknown, hostId: string) {
    const snapshot = hostStateSchema.parse(input);
    if (snapshot.hostId !== hostId) throw new TestRunError(409, "Host snapshot differs from authenticated controller");
    const current = await TestHostStateModel.findOne({hostId}).lean();
    if (current && (current.incarnation === snapshot.incarnation ? snapshot.sequence <= current.sequence : Date.parse(snapshot.observedAt) <= current.observedAt.getTime()))
      return {hostId, incarnation: current.incarnation, sequence: current.sequence};
    const filter = current ? {hostId, incarnation: current.incarnation, sequence: current.sequence} : {hostId};
    try {
      const saved = await TestHostStateModel.findOneAndUpdate(filter, {$set: {hostId, incarnation: snapshot.incarnation,
        sequence: snapshot.sequence, observedAt: new Date(snapshot.observedAt), snapshot}}, {upsert: !current, new: true, writeConcern: testWriteConcern}).lean();
      if (!saved) throw new TestRunError(409, "Controller snapshot advanced concurrently; retry current observation");
      return {hostId, incarnation: saved.incarnation, sequence: saved.sequence};
    } catch (error) {if ((error as {code?: number}).code === 11000) throw new TestRunError(409, "Controller snapshot advanced concurrently"); throw error;}
  }
  async get(hostId: string): Promise<TestHostState | null> {
    const row = await TestHostStateModel.findOne({hostId}).lean();
    return row ? hostStateSchema.parse(row.snapshot) : null;
  }
}
