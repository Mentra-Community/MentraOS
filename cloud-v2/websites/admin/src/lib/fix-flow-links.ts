
export type FixFlowLink = { occurrenceId: string } | { runId: string; stepId: string };
const occurrence = /^tfo_[a-f0-9]{64}$/;
const run = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const step = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
export function readFixFlowLink(search: string): FixFlowLink | null {
  const query = new URLSearchParams(search);
  const id = query.get("fixFlow"), runId = query.get("fixFlowRun"), stepId = query.get("fixStep");
  if (["fixFlow", "fixFlowRun", "fixStep"].some(key => query.getAll(key).length > 1)) return null;
  if (id && occurrence.test(id) && !runId && !stepId) return { occurrenceId: id };
  return !id && runId && stepId && run.test(runId) && step.test(stepId) ? { runId, stepId } : null;
}
export function fixFlowHref(link: FixFlowLink | null): string {
  const query = new URLSearchParams();
  if (!link) query.set("fixFlows", "active");
  else if ("occurrenceId" in link) query.set("fixFlow", link.occurrenceId);
  else { query.set("fixFlowRun", link.runId); query.set("fixStep", link.stepId); }
  return `/?${query}`;
}
export function fixFlowApiPath(link: FixFlowLink): string {
  return "occurrenceId" in link ? `/api/admin/fix-flows/${encodeURIComponent(link.occurrenceId)}`
    : `/api/admin/fix-flows/runs/${encodeURIComponent(link.runId)}/steps/${encodeURIComponent(link.stepId)}`;
}
