import { isAdminEmail } from "./admin-email-policy";

/** Shared with the admin report query; Testing takes precedence over stored kind. */
export const REPORT_TESTING_SOURCE = "mentra_automated_testing";
export type ReportCategory = "bug" | "feedback" | "internal" | "testing" | "automatic";

/** Use only the resolved first-party account email, never client-supplied contact/context fields.
 * Classification uses the current admin allowlist, as the dashboard does at query time. */
export function reportCategory(report: {
  kind: "bug" | "feedback" | "automatic";
  trigger?: { source?: string } | null;
  userEmail?: string | null;
}): ReportCategory {
  if (report.trigger?.source === REPORT_TESTING_SOURCE) return "testing";
  if (report.kind === "automatic") return "automatic";
  if (report.userEmail && isAdminEmail(report.userEmail)) return "internal";
  return report.kind;
}
