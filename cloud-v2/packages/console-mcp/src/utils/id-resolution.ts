import type {
  AdminReportsClient,
  ReportAsset,
  ReportDetail,
} from "../http/admin-reports-client";
import { ApiRequestError } from "../http/errors";

/** Full report ids are `rep_` + 26-char ULID. */
const FULL_REPORT_ID = /^rep_[0-9A-HJKMNP-TV-Z]{26}$/;

const SCAN_PAGE_SIZE = 200;
const SCAN_MAX_PAGES = 3;

/**
 * Stored ids are `rep_` + an uppercase ULID; pastes arrive in any case
 * (URLs and chat clients lowercase them). Rebuild the canonical form so
 * both the exact lookup and the prefix comparisons match storage.
 */
function canonicalizeReportId(id: string): string {
  const match = /^(rep_)?(.*)$/i.exec(id.trim());
  return `${match?.[1] ? "rep_" : ""}${(match?.[2] ?? "").toUpperCase()}`;
}

/**
 * Fetch a report by full id or short prefix (with or without the `rep_`
 * prefix, as pasted from Slack or the admin console). Exact lookup first;
 * on a miss, prefix-match against the most recent reports (newest-first,
 * up to SCAN_MAX_PAGES × SCAN_PAGE_SIZE) — triage targets are recent, so a
 * bounded scan beats walking the whole collection.
 */
export async function resolveReport(
  client: AdminReportsClient,
  id: string,
): Promise<{ report: ReportDetail; assets: ReportAsset[] }> {
  const query = canonicalizeReportId(id);
  try {
    return await client.getReport(query);
  } catch (error) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    if (!notFound || FULL_REPORT_ID.test(query)) {
      throw error;
    }
  }

  const matches: string[] = [];
  let before: string | undefined;
  let scanned = 0;

  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const { reports } = await client.listReports({ limit: SCAN_PAGE_SIZE, before });
    scanned += reports.length;
    for (const r of reports) {
      if (r.reportId.startsWith(query) || r.reportId.startsWith(`rep_${query}`)) {
        matches.push(r.reportId);
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous report id prefix "${query}" — matches: ${matches.slice(0, 5).join(", ")}`,
      );
    }
    const oldest = reports[reports.length - 1];
    if (reports.length < SCAN_PAGE_SIZE || !oldest?.createdAt) {
      break;
    }
    // The list API filters strictly before this timestamp, so rows sharing
    // the boundary millisecond can be skipped between pages. Accepted for
    // this best-effort scan; the miss path tells the user to pass a full id.
    before = oldest.createdAt;
  }

  if (matches.length === 1) {
    return client.getReport(matches[0]);
  }
  throw new Error(
    `No report matching "${query}" in the ${scanned} most recent reports — pass the full rep_... id`,
  );
}
