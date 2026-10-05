import {z} from "zod";
import {TestHostStateModel} from "../models/test-host-state.model";
import {testWriteConcern} from "../models/test-write-concern";
import {frameworkIdentitySchema} from "../types/framework-request.types";
import {glassesModelSchema, routineIdentitySchema, routinePlatformSchema} from "../types/routine-definition.types";
import {laneRestorationProjectionSchema} from "../types/lane-restoration.types";
import {TestRunError} from "./test-result-error";
const resource = z.object({id: frameworkIdentitySchema, kind: z.enum(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]), laneId: frameworkIdentitySchema.optional()}).strict();
export const glassesInventorySchema = z.object({resourceId: frameworkIdentitySchema, deviceId: frameworkIdentitySchema,
  model: glassesModelSchema, capabilities: z.array(routineIdentitySchema).max(30)}).strict()
  .refine(value => new Set(value.capabilities).size === value.capabilities.length, "Offered glasses capabilities must be unique");
const routineAvailability = z.object({routineId: routineIdentitySchema,
  definitionRevision: z.string().regex(/^[a-f0-9]{40}$/), available: z.boolean(), reason: z.string().min(1).max(2000).optional()}).strict();
export const hostStateSchema = z.object({hostId: frameworkIdentitySchema, incarnation: frameworkIdentitySchema,
  incarnationGeneration: z.number().int().positive().safe(), sequence: z.number().int().nonnegative().safe(), observedAt: z.string().datetime({offset: true}),
  lanes: z.array(z.object({id: frameworkIdentitySchema, platform: routinePlatformSchema,
    dispatchMode: z.enum(["automatic", "authoring", "paused"]),
    state: z.enum(["idle", "running", "reserved", "in-repair", "out-of-service", "offline"]),
    resources: z.array(resource), glasses: z.array(glassesInventorySchema).max(30).optional(),
    routineAvailability: z.array(routineAvailability).max(1000).optional()}).strict()
    .superRefine((lane, ctx) => {
      const keys = lane.routineAvailability?.map(row => `${row.routineId}:${row.definitionRevision}`) ?? [];
      if (new Set(keys).size !== keys.length) ctx.addIssue({code: "custom", message: "Duplicate lane routine availability identity"});
      const ids = lane.resources.map(ref => ref.id);
      if (new Set(ids).size !== ids.length) ctx.addIssue({code: "custom", message: "Duplicate lane resource identity"});
      if (lane.glasses === undefined && lane.resources.some(ref => ref.kind === "glasses"))
        ctx.addIssue({code: "custom", message: "Declared glasses resources require physical inventory"});
      if (lane.glasses !== undefined) {
        const offered = lane.glasses.map(value => value.resourceId);
        if (new Set(offered).size !== offered.length || new Set(lane.glasses.map(value => value.deviceId)).size !== offered.length)
          ctx.addIssue({code: "custom", message: "Duplicate lane glasses identity"});
        if (lane.resources.filter(ref => ref.kind === "glasses").some(ref => !offered.includes(ref.id)) ||
          lane.glasses.some(value => !lane.resources.some(ref => ref.id === value.resourceId && ref.kind === "glasses")))
          ctx.addIssue({code: "custom", message: "Glasses inventory must exactly identify declared glasses resources"});
      }
    })).max(100), restoration: laneRestorationProjectionSchema.optional()}).strict().superRefine((snapshot, ctx) => {
      if (new Set(snapshot.lanes.map(lane => lane.id)).size !== snapshot.lanes.length)
        ctx.addIssue({code: "custom", message: "Duplicate host lane identity"});
      if (snapshot.restoration?.attempts.some(attempt => !snapshot.lanes.some(lane => lane.id === attempt.laneId)))
        ctx.addIssue({code: "custom", message: "Restoration attempt names an unknown host lane"});
      const byResource = new Map<string, string>(), byDevice = new Map<string, string>();
      for (const lane of snapshot.lanes) for (const glasses of lane.glasses ?? []) {
        const identity = JSON.stringify({deviceId: glasses.deviceId, model: glasses.model});
        if (byResource.has(glasses.resourceId) && byResource.get(glasses.resourceId) !== identity ||
          byDevice.has(glasses.deviceId) && byDevice.get(glasses.deviceId) !== glasses.resourceId)
          ctx.addIssue({code: "custom", message: "Shared physical glasses must retain one resource, device and model identity across lanes"});
        byResource.set(glasses.resourceId, identity); byDevice.set(glasses.deviceId, glasses.resourceId);
      }
    });
export type TestHostState = z.infer<typeof hostStateSchema>;
export type ReceivedTestHostState = TestHostState & {receivedAt: string};
export class TestHostStateService {
  constructor(private readonly now: () => number = Date.now) {}
  async report(input: unknown, hostId: string) {
    const snapshot = hostStateSchema.parse(input);
    if (snapshot.hostId !== hostId) throw new TestRunError(409, "Host snapshot differs from authenticated controller");
    const current = await TestHostStateModel.findOne({hostId}).lean();
    if (current) {
      if (snapshot.incarnationGeneration === current.incarnationGeneration && snapshot.incarnation !== current.incarnation)
        throw new TestRunError(409, "Controller incarnation generation belongs to another process");
      if (snapshot.incarnationGeneration < current.incarnationGeneration ||
        snapshot.incarnationGeneration === current.incarnationGeneration && snapshot.sequence <= current.sequence)
        return {hostId, incarnation: current.incarnation, incarnationGeneration: current.incarnationGeneration, sequence: current.sequence};
    }
    const filter = current ? {hostId, incarnation: current.incarnation, incarnationGeneration: current.incarnationGeneration, sequence: current.sequence} : {hostId};
    try {
      const saved = await TestHostStateModel.findOneAndUpdate(filter, {$set: {hostId, incarnation: snapshot.incarnation,
        incarnationGeneration: snapshot.incarnationGeneration, sequence: snapshot.sequence, observedAt: new Date(snapshot.observedAt), receivedAt: new Date(this.now()), snapshot}}, {upsert: !current, new: true, writeConcern: testWriteConcern}).lean();
      if (!saved) throw new TestRunError(409, "Controller snapshot advanced concurrently; retry current observation");
      return {hostId, incarnation: saved.incarnation, incarnationGeneration: saved.incarnationGeneration, sequence: saved.sequence};
    } catch (error) {if ((error as {code?: number}).code === 11000) throw new TestRunError(409, "Controller snapshot advanced concurrently"); throw error;}
  }
  async get(hostId: string): Promise<ReceivedTestHostState | null> {
    const row = await TestHostStateModel.findOne({hostId}).lean();
    return row ? {...hostStateSchema.parse(row.snapshot), receivedAt: row.receivedAt.toISOString()} : null;
  }
}
