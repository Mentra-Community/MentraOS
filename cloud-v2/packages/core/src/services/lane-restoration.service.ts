import {TestHostStateModel} from "../models/test-host-state.model";
import type {LaneRestorationList} from "../types/lane-restoration.types";
import {hostStateSchema} from "./test-host-state.service";
import {TestRunError} from "./test-result-error";

const HOST_LIMIT = 32;
type StoredState = {snapshot: unknown; receivedAt: Date};
export interface LaneRestorationRepository {list(limit: number): Promise<StoredState[]>}
class MongoLaneRestorationRepository implements LaneRestorationRepository {
  async list(limit: number) {
    return await TestHostStateModel.find({}).select({snapshot: 1, receivedAt: 1, _id: 0}).sort({hostId: 1})
      .limit(limit).maxTimeMS(5_000).read("primary").readConcern("majority").lean() as StoredState[];
  }
}
/** Controller snapshots are observations, never permission to resume or start a repair agent. */
export class LaneRestorationService {
  constructor(private repository: LaneRestorationRepository = new MongoLaneRestorationRepository(), private now = Date.now) {}
  async list(): Promise<LaneRestorationList> {
    const rows = await this.repository.list(HOST_LIMIT + 1);
    const hosts = rows.slice(0, HOST_LIMIT).map(row => {
      const parsed = hostStateSchema.safeParse(row.snapshot);
      if (!parsed.success || !Number.isFinite(row.receivedAt?.getTime()))
        throw new TestRunError(503, "Stored lane restoration observation is unavailable.");
      const {hostId, observedAt, lanes, restoration} = parsed.data;
      return {hostId, observedAt, receivedAt: row.receivedAt.toISOString(),
        lanes: lanes.map(({id, platform, state, dispatchMode}) => ({id, platform, state, dispatchMode})),
        restoration: restoration ?? null};
    });
    return {generatedAt: new Date(this.now()).toISOString(), freshForMs: 120_000, hosts, truncated: rows.length > HOST_LIMIT};
  }
}
