/** Identity of the single device incident request saved by an automated run.
 * This binds report creation, independently of transport or collection completion.
 */
export interface ReportAutomationCorrelation {
  alertId: string;
  testRunId: string;
}

/** Preserve exact request IDs; never normalize or truncate correlation. */
export function reportAutomationCorrelation(value: unknown): ReportAutomationCorrelation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || typeof row.alertId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(row.alertId)
    || typeof row.testRunId !== 'string' || !row.testRunId.trim() || row.testRunId.length > 160) return null;
  return {alertId: row.alertId, testRunId: row.testRunId};
}
