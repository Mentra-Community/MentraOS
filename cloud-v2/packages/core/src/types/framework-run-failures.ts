import type {RecordedFrameworkRun} from './framework-run.types';

/** Read recorded causes once for display/classification without changing diagnostic copies. */
export function frameworkFailures(result: RecordedFrameworkRun['result']) {
  const seen = new Set<string>();
  return [...result.failures, ...result.teardown.errors, ...result.teardown.outcomes.flatMap(outcome =>
    [...outcome.errors ?? [], ...(outcome.state === 'failed' ? [outcome.failure] : [])])].filter(error => {
    const key = JSON.stringify([error.phase, error.actionId, error.message]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
