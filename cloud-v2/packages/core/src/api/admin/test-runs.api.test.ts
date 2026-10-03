import {expect, test} from "bun:test";
import {createTestRunAdminApi} from "./test-runs.api";
import {TestHistoryService} from "../../services/test-history.service";
import {TestHostHealthService} from "../../services/test-host-health.service";

test("combined history route forwards pagination before the generic run route", async () => {
  const calls: Record<string, string>[] = [];
  class History extends TestHistoryService {
    override async list(query: Record<string, string> = {}) {
      calls.push(query); return {entries: [], nextCursor: null};
    }
  }
  const response = await createTestRunAdminApi(new TestHostHealthService(), new History()).request("/history?limit=3&cursor=next");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({entries: [], nextCursor: null});
  expect(calls).toEqual([{limit: "3", cursor: "next"}]);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
