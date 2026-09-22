export type TestRunLink = { runID: string; stepID?: string };
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

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
