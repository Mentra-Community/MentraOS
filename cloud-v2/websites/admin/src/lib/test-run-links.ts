export type TestRunLink = { runID: string; stepID?: string };
export type TestRunListScope = {
  repository: string;
  pr: string;
  headSha: string;
  archiveSha256: string;
  routineId: string;
  platform: "ios-mac" | "ios" | "android";
};
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const LIST_KEYS = ["testRuns", "repository", "pr", "headSha", "archiveSha256", "routineId", "platform"] as const;

/** The whole scope is required: a malformed build link must not show older PR results. */
export function readTestRunListScope(search: string): TestRunListScope | null {
  const query = new URLSearchParams(search);
  if (LIST_KEYS.some((key) => query.getAll(key).length !== 1) || query.get("testRuns") !== "1") return null;
  const repository = query.get("repository")!;
  const pr = query.get("pr")!;
  const headSha = query.get("headSha")!;
  const archiveSha256 = query.get("archiveSha256")!;
  const routineId = query.get("routineId")!;
  const platform = query.get("platform")!;
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.length > 200 ||
    !/^[1-9]\d*$/.test(pr) ||
    !Number.isSafeInteger(Number(pr)) ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    !/^[a-f0-9]{64}$/.test(archiveSha256) ||
    !RESOURCE_ID.test(routineId) ||
    !["ios-mac", "ios", "android"].includes(platform)
  )
    return null;
  return { repository, pr, headSha, archiveSha256, routineId, platform: platform as TestRunListScope["platform"] };
}

export function testRunListLocation(current: string, scope: TestRunListScope | null): string {
  const url = new URL(current);
  for (const key of LIST_KEYS) url.searchParams.delete(key);
  if (scope) {
    url.searchParams.delete("report");
    url.searchParams.set("testRuns", "1");
    for (const [key, value] of Object.entries(scope)) url.searchParams.set(key, value);
  }
  return url.pathname + url.search + url.hash;
}

function identifier(value: string | null): value is string {
  return !!value && value.length <= 160 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

/** Keep these query parameters intact until authentication has finished. */
export function readTestRunLink(search: string): TestRunLink | null {
  const query = new URLSearchParams(search);
  const runID = query.get("testRun");
  const stepID = query.get("step");
  if (
    query.getAll("testRun").length !== 1 ||
    query.getAll("step").length > 1 ||
    !identifier(runID) ||
    !RESOURCE_ID.test(runID)
  )
    return null;
  return { runID, ...(identifier(stepID) ? { stepID } : {}) };
}

export function testRunLocation(current: string, selection: TestRunLink | null): string {
  const url = new URL(current);
  url.searchParams.delete("testRun");
  url.searchParams.delete("step");
  if (selection) {
    url.searchParams.delete("report");
    url.searchParams.set("testRun", selection.runID);
    if (selection.stepID) url.searchParams.set("step", selection.stepID);
  }
  return url.pathname + url.search + url.hash;
}

/** Asset IDs are the only media selector; never load a URL supplied in an uploaded report. */
export function testRunAssetPath(runID: string, assetID: string): string {
  if (!RESOURCE_ID.test(runID) || !RESOURCE_ID.test(assetID)) throw new Error("Invalid test run or asset ID");
  return `/api/admin/test-runs/${encodeURIComponent(runID)}/assets/${encodeURIComponent(assetID)}`;
}
