/**
 * Decide whether a workflow_run-triggered orchestrator invocation should
 * bail before Plan (blank pr_number) because the PR is already sitting in
 * human handoff and late CI completions would only burn runner time.
 *
 * pull_request / workflow_dispatch must never take this shortcut — humans
 * may push new commits or apply agent-resume, and those events need Plan.
 */
export function shouldBlankPrForWorkflowRunHandoff(
  eventName: string,
  labelNames: string[],
): boolean {
  if (eventName !== 'workflow_run') return false;
  const labels = new Set(labelNames);
  return labels.has('ready-for-human-review') && !labels.has('agent-resume');
}
