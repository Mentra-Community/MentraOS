import { describe, expect, test } from "bun:test";
import type {
  AdminReportsClient,
  ReportDetail,
  ReportSummary,
} from "../src/http/admin-reports-client";
import { ApiRequestError } from "../src/http/errors";
import { resolveReport } from "../src/utils/id-resolution";

const FULL_ID = "rep_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ID = "rep_01BX5ZZKBKACTAV9WEVGEMMVRZ";

function summary(reportId: string, createdAt = "2026-07-01T00:00:00.000Z"): ReportSummary {
  return {
    reportId,
    kind: "bug",
    status: "ready",
    mentraUserId: "user@example.com",
    trigger: null,
    report: null,
    feedback: null,
    artifacts: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function detail(reportId: string): ReportDetail {
  return { ...summary(reportId), context: {} };
}

interface MockCalls {
  getReport: string[];
  listReports: Array<{ limit?: number; before?: string }>;
}

function mockClient(options: {
  known: string[];
  pages?: ReportSummary[][];
}): { client: AdminReportsClient; calls: MockCalls } {
  const calls: MockCalls = { getReport: [], listReports: [] };
  const pages = options.pages ?? [options.known.map((id) => summary(id))];
  const client = {
    getReport: async (reportId: string) => {
      calls.getReport.push(reportId);
      if (options.known.includes(reportId)) {
        return { report: detail(reportId), assets: [] };
      }
      throw new ApiRequestError("not found", 404);
    },
    listReports: async (filter: { limit?: number; before?: string } = {}) => {
      calls.listReports.push(filter);
      return { reports: pages[Math.min(calls.listReports.length - 1, pages.length - 1)] ?? [] };
    },
  } as unknown as AdminReportsClient;
  return { client, calls };
}

describe("resolveReport", () => {
  test("returns an exact match without scanning the list", async () => {
    const { client, calls } = mockClient({ known: [FULL_ID] });
    const { report } = await resolveReport(client, FULL_ID);
    expect(report.reportId).toBe(FULL_ID);
    expect(calls.listReports).toHaveLength(0);
  });

  test("rethrows 404 for a full-length id without scanning", async () => {
    const { client, calls } = mockClient({ known: [] });
    await expect(resolveReport(client, OTHER_ID)).rejects.toThrow(ApiRequestError);
    expect(calls.listReports).toHaveLength(0);
  });

  test("resolves a short prefix including the rep_ prefix", async () => {
    const { client } = mockClient({ known: [FULL_ID, OTHER_ID] });
    const { report } = await resolveReport(client, "rep_01ARZ");
    expect(report.reportId).toBe(FULL_ID);
  });

  test("resolves a short prefix without the rep_ prefix", async () => {
    const { client } = mockClient({ known: [FULL_ID, OTHER_ID] });
    const { report } = await resolveReport(client, "01BX5");
    expect(report.reportId).toBe(OTHER_ID);
  });

  test("canonicalizes a lowercased full id before the exact lookup", async () => {
    const { client, calls } = mockClient({ known: [FULL_ID] });
    const { report } = await resolveReport(client, FULL_ID.toLowerCase());
    expect(report.reportId).toBe(FULL_ID);
    expect(calls.getReport[0]).toBe(FULL_ID);
    expect(calls.listReports).toHaveLength(0);
  });

  test("matches lowercase and mixed-case prefixes", async () => {
    const { client } = mockClient({ known: [FULL_ID, OTHER_ID] });
    expect((await resolveReport(client, "rep_01arz")).report.reportId).toBe(FULL_ID);
    expect((await resolveReport(client, "01Bx5z")).report.reportId).toBe(OTHER_ID);
  });

  test("rejects an ambiguous prefix, naming the matches", async () => {
    const { client } = mockClient({ known: [FULL_ID, OTHER_ID] });
    await expect(resolveReport(client, "01")).rejects.toThrow(/Ambiguous.*rep_01ARZ/);
  });

  test("pages back with the oldest createdAt as the cursor", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) =>
      summary(`rep_PAGE1${String(i).padStart(3, "0")}`, `2026-07-0${(i % 8) + 1}T00:00:00.000Z`),
    );
    fullPage[199] = summary("rep_PAGE1OLDEST", "2026-06-01T00:00:00.000Z");
    const { client, calls } = mockClient({
      known: [FULL_ID],
      pages: [fullPage, [summary(FULL_ID)]],
    });
    const { report } = await resolveReport(client, "01ARZ");
    expect(report.reportId).toBe(FULL_ID);
    expect(calls.listReports).toHaveLength(2);
    expect(calls.listReports[1].before).toBe("2026-06-01T00:00:00.000Z");
  });

  test("reports how many recent reports were scanned on a miss", async () => {
    const { client } = mockClient({ known: [OTHER_ID] });
    await expect(resolveReport(client, "01ARZ")).rejects.toThrow(/1 most recent reports/);
  });
});
