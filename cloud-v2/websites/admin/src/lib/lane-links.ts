import {frameworkIdentitySchema} from "../../../../packages/core/src/types/framework-request.types";

export type LaneSelection = {hostId: string; laneId: string};
export function laneHistoryHref(hostId: string, laneId: string) {
  return `/?systemHealth=1&hostId=${encodeURIComponent(hostId)}&laneId=${encodeURIComponent(laneId)}`;
}
export function readLaneSelection(search: string): LaneSelection | null {
  const query = new URLSearchParams(search);
  if (query.get("systemHealth") !== "1" || query.getAll("hostId").length !== 1 || query.getAll("laneId").length !== 1) return null;
  const hostId = query.get("hostId")!, laneId = query.get("laneId")!;
  return frameworkIdentitySchema.safeParse(hostId).success && frameworkIdentitySchema.safeParse(laneId).success ? {hostId, laneId} : null;
}

