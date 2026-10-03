import {expect, spyOn, test} from "bun:test";
import {createTestRunAdminApi} from "./test-runs.api";
import {TestHistoryService} from "../../services/test-history.service";
import {TestHostHealthService} from "../../services/test-host-health.service";
import {FrameworkResultService} from "../../services/framework-result.service";

test("combined history route forwards pagination outside the generic run ID path", async () => {
  const calls: Record<string, string>[] = [];
  class History extends TestHistoryService {
    override async list(query: Record<string, string> = {}) {
      calls.push(query); return {entries: [], nextCursor: null};
    }
  }
  const response = await createTestRunAdminApi(new TestHostHealthService(), new History()).request("/history/list?limit=3&cursor=next");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({entries: [], nextCursor: null});
  expect(calls).toEqual([{limit: "3", cursor: "next"}]);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("the valid run ID history still opens its individual result", async () => {
  const detail = spyOn(FrameworkResultService.prototype, "detailByRun").mockResolvedValue({runId: "history"} as never);
  try {
    const response = await createTestRunAdminApi().request("/history");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({runId: "history"});
    expect(detail).toHaveBeenCalledWith("history");
  } finally {detail.mockRestore();}
});
