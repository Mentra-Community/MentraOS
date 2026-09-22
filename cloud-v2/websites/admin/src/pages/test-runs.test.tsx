import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  readTestRunLink,
  readTestRunListScope,
  testRunListLocation,
  testRunAssetPath,
  testRunLocation,
} from "../lib/test-run-links";
import {
  chapterSeekTime,
  EMPTY_FILTERS,
  initialChapter,
  safeProducerUrl,
  testRunListPath,
  type TestRunDetail,
} from "./test-runs-data";
import { TestRunsPage, TestRunView } from "./test-runs";

// Synthetic render fixture only; never uploaded or presented as a device result.
const run: TestRunDetail = {
  runId: "synthetic-run",
  requestId: "synthetic-request",
  routineId: "synthetic-ota",
  routineVersion: "test-only",
  platform: "ios-mac",
  channel: "local",
  startedAt: "2026-09-22T01:00:00Z",
  finishedAt: "2026-09-22T01:10:00Z",
  outcome: "failed",
  outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "complete" },
  provenance: { repository: "example/synthetic", buildSha: "a".repeat(40), manifestSha256: "b".repeat(64) },
  fixture: { alias: "Synthetic fixture" },
  firmwareAssertions: [{ component: "BES", expected: "26.9.21.1", actual: "26.1.13.1", status: "failed" }],
  chapters: [
    {
      id: "start",
      instruction: "Open Updates",
      phase: "setup",
      status: "passed",
      videoAssetId: "video-one",
      videoStart: 0,
      videoEnd: 3,
    },
    {
      id: "failed-step",
      instruction: "Verify the installed firmware",
      expected: "Version matches the selected manifest",
      phase: "verify",
      status: "failed",
      videoAssetId: "video-one",
      videoStart: 4,
      videoEnd: 8,
      screenshotAssetId: "screen-one",
    },
  ],
  assets: [
    {
      assetId: "video-one",
      kind: "video",
      contentType: "video/mp4",
      filename: "routine.mp4",
      sizeBytes: 100,
      sha256: "c".repeat(64),
      uploaded: true,
    },
    {
      assetId: "screen-one",
      kind: "screenshot",
      contentType: "image/png",
      filename: "verification.png",
      sizeBytes: 10,
      sha256: "d".repeat(64),
      uploaded: true,
    },
  ],
};

describe("authenticated result navigation", () => {
  const buildQuery = new URLSearchParams({
    testRuns: "1",
    repository: "Mentra-Community/MentraOS",
    pr: "4136",
    headSha: "a".repeat(40),
    archiveSha256: "b".repeat(64),
    routineId: "day1-ota",
    platform: "ios-mac",
  });
  test("exact build scope survives login, detail navigation and back to results", () => {
    const location = `https://admin.dev.mentraglass.com/?${buildQuery}`;
    const login = new URL("/api/console/auth/login", location);
    login.searchParams.set("return_to", location);
    const returned = new URL(login.searchParams.get("return_to")!);
    const scope = readTestRunListScope(returned.search)!;
    expect(scope).toEqual({
      repository: "Mentra-Community/MentraOS",
      pr: "4136",
      headSha: "a".repeat(40),
      archiveSha256: "b".repeat(64),
      routineId: "day1-ota",
      platform: "ios-mac",
    });
    const detail = new URL(testRunLocation(returned.href, { runID: "example-01", stepID: "OTA-01" }), returned);
    expect(readTestRunListScope(detail.search)).toEqual(scope);
    const back = new URL(testRunLocation(detail.href, null), returned);
    expect(readTestRunLink(back.search)).toBeNull();
    expect(readTestRunListScope(back.search)).toEqual(scope);
    expect(testRunListLocation(back.href, null)).toBe("/");
    const path = new URL(
      testRunListPath(
        { ...EMPTY_FILTERS, pr: "1", channel: "local", routineId: "other", platform: "android", outcome: "failed" },
        "cursor-2",
        scope,
      ),
      returned,
    );
    expect(Object.fromEntries(path.searchParams)).toEqual({
      ...scope,
      channel: "pr",
      outcome: "failed",
      cursor: "cursor-2",
      limit: "25",
    });
  });
  test("incomplete or ambiguous build links cannot select an unscoped results list", () => {
    for (const key of ["testRuns", "repository", "pr", "headSha", "archiveSha256", "routineId", "platform"]) {
      const missing = new URLSearchParams(buildQuery);
      missing.delete(key);
      expect(readTestRunListScope(missing.toString())).toBeNull();
      const duplicate = new URLSearchParams(buildQuery);
      duplicate.append(key, buildQuery.get(key)!);
      expect(readTestRunListScope(duplicate.toString())).toBeNull();
    }
    for (const [key, value] of [
      ["repository", "../repo"],
      ["pr", "9007199254740993"],
      ["headSha", "abcdef"],
      ["archiveSha256", "missing"],
      ["routineId", "../id"],
      ["platform", "unknown"],
    ]) {
      const invalid = new URLSearchParams(buildQuery);
      invalid.set(key!, value!);
      expect(readTestRunListScope(invalid.toString())).toBeNull();
    }
  });
  test("a new build shows an honest empty state and keeps its identity filters fixed", () => {
    const scope = readTestRunListScope(buildQuery.toString())!;
    const client = new QueryClient();
    client.setQueryData(["admin-test-runs", EMPTY_FILTERS, scope], {
      pages: [{ runs: [], nextCursor: null }],
      pageParams: [undefined],
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TestRunsPage selection={null} onSelect={() => {}} scope={scope} onClearScope={() => {}} />
      </QueryClientProvider>,
    );
    expect(markup).toContain("No results for this build yet");
    expect(markup).toContain("Results appear after the device run is uploaded");
    expect(markup).toContain("PR #4136");
    expect(markup).toContain(scope.archiveSha256);
    expect(markup).toMatch(/disabled=""[^>]*aria-label="PR number"/);
    expect(markup).toMatch(/aria-label="Platform"[^>]*disabled=""/);
    expect(markup).not.toContain("No test runs found");
    client.clear();
  });
  test("a run and English step link survive the login return URL round trip", () => {
    const location = "https://admin.mentraglass.com/?testRun=run-01&step=BES%20version%3F#evidence";
    const login = new URL("/api/console/auth/login", location);
    login.searchParams.set("return_to", location);
    const returned = new URL(login.searchParams.get("return_to")!);
    expect(readTestRunLink(returned.search)).toEqual({ runID: "run-01", stepID: "BES version?" });
    expect(testRunLocation(returned.href, { runID: "run-02", stepID: "MTK-03" })).toBe(
      "/?testRun=run-02&step=MTK-03#evidence",
    );
    expect(testRunLocation(returned.href, null)).toBe("/#evidence");
  });
  test("ambiguous IDs and path traversal cannot become authenticated media paths", () => {
    expect(readTestRunLink("?testRun=one&testRun=two")).toBeNull();
    expect(readTestRunLink("?testRun=..%2Fother")).toBeNull();
    expect(testRunAssetPath("run-one", "asset_one")).toBe("/api/admin/test-runs/run-one/assets/asset_one");
    for (const id of ["..", "../other", "https://elsewhere.invalid/video", "a/b", "%2F"]) {
      expect(() => testRunAssetPath("run-one", id)).toThrow();
    }
  });
  test("query filters stay on the current admin backend and encode cursor values", () => {
    const path = testRunListPath(
      { ...EMPTY_FILTERS, pr: "4136", channel: "staging", outcome: "failed" },
      "cursor/one+two",
    );
    const url = new URL(path, "https://admin.mentraglass.com");
    expect(url.origin).toBe("https://admin.mentraglass.com");
    expect(url.searchParams.get("pr")).toBe("4136");
    expect(url.searchParams.get("channel")).toBe("staging");
    expect(url.searchParams.get("cursor")).toBe("cursor/one+two");
    expect(() => testRunListPath({ ...EMPTY_FILTERS, pr: "1&channel=prod" })).toThrow();
    const range = new URL(
      testRunListPath({ ...EMPTY_FILTERS, startedAfter: "2026-09-21", startedBefore: "2026-09-22" }),
      url,
    );
    expect(Date.parse(range.searchParams.get("startedAfter")!)).toBeLessThan(
      Date.parse(range.searchParams.get("startedBefore")!),
    );
    expect(() => testRunListPath({ ...EMPTY_FILTERS, startedAfter: "2026-02-30" })).toThrow();
    expect(() =>
      testRunListPath({ ...EMPTY_FILTERS, startedAfter: "2026-09-22", startedBefore: "2026-09-21" }),
    ).toThrow();
  });
});

describe("recording and chapter integrity", () => {
  test("opens a failed step by default and honors an explicit recorded step", () => {
    expect(initialChapter(run.chapters)?.id).toBe("failed-step");
    expect(initialChapter(run.chapters, "start")?.id).toBe("start");
    expect(initialChapter(run.chapters, "missing")?.id).toBe("failed-step");
  });
  test("only seeks within the selected uploaded recording", () => {
    const chapter = run.chapters[1];
    const asset = run.assets[0];
    expect(chapterSeekTime(chapter, asset, 10)).toBe(4);
    expect(chapterSeekTime(chapter, { ...asset, uploaded: false }, 10)).toBeNull();
    expect(chapterSeekTime(chapter, { ...asset, assetId: "another-video" }, 10)).toBeNull();
    for (const patch of [
      { videoStart: -1 },
      { videoStart: NaN },
      { videoStart: 11 },
      { videoEnd: 2 },
      { videoEnd: 20 },
    ]) {
      expect(chapterSeekTime({ ...chapter, ...patch }, asset, 10)).toBeNull();
    }
    expect(chapterSeekTime(chapter, asset, Infinity)).toBeNull();
  });
  test("uses authenticated asset routes, preserves separate outcomes and escapes report content", () => {
    const markup = renderToStaticMarkup(
      <TestRunView run={{ ...run, notes: "<script>alert('uploaded report')</script>" }} onStep={() => {}} />,
    );
    expect(markup).toContain('src="/api/admin/test-runs/synthetic-run/assets/video-one"');
    expect(markup).toContain('src="/api/admin/test-runs/synthetic-run/assets/screen-one"');
    expect(markup).toContain('aria-current="step"');
    expect(markup).toContain(">teardown</p>");
    expect(markup).toContain("26.1.13.1");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain("Not recorded"); // Existing manual assertions have no phase.
  });
  test("shows the original failed firmware check separately from a successful return", () => {
    const markup = renderToStaticMarkup(
      <TestRunView
        run={{
          ...run,
          firmwareAssertions: [
            {
              component: "BES version",
              expected: "26.9.21.3",
              actual: "17.26.1.13",
              status: "failed",
              phase: "final-assertions",
            },
            {
              component: "BES version",
              expected: "26.9.21.3",
              actual: "26.9.21.3",
              status: "passed",
              phase: "return-verification",
            },
          ],
        }}
        onStep={() => {}}
      />,
    );
    const rows = [...markup.matchAll(/<tr[\s>][\s\S]*?<\/tr>/g)].map((match) => match[0]);
    const original = rows.find((row) => row.includes("Final test checks"))!;
    const returned = rows.find((row) => row.includes("Return verification"))!;
    expect(original).toContain("17.26.1.13");
    expect(original).toContain(">failed<");
    expect(returned).toContain("26.9.21.3");
    expect(returned).toContain(">passed<");
  });
  test("links a recovery result to the original run while retaining the failed test outcome", () => {
    const markup = renderToStaticMarkup(
      <TestRunView
        run={{
          ...run,
          provenance: {
            ...run.provenance,
            originalRunId: "original_run-01",
            resultGeneration: "2",
            previousResultRunId: "original_run-01",
          },
        }}
        onStep={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Recovery result"');
    expect(markup).toContain('href="/?testRun=original_run-01"');
    expect(markup).toContain("The original test outcome is preserved.");
    expect(markup).toMatch(/>test<\/p>[\s\S]*?>failed<\/span>/);
    expect(markup).toMatch(/>fixture<\/p>[\s\S]*?>ready<\/span>/);
  });
  test("only valid distinct original run IDs produce a recovery link", () => {
    for (const originalRunId of [
      undefined,
      run.runId,
      "../other",
      "https://elsewhere.invalid",
      "one&testRun=two",
      "\ud800",
      "a".repeat(121),
    ]) {
      const markup = renderToStaticMarkup(
        <TestRunView run={{ ...run, provenance: { ...run.provenance, originalRunId } }} onStep={() => {}} />,
      );
      expect(markup).not.toContain('aria-label="Recovery result"');
      expect(markup).not.toContain("View original run");
    }
  });
  test("incomplete media gets explicit text and is never requested as a playable recording", () => {
    const markup = renderToStaticMarkup(
      <TestRunView
        run={{ ...run, assets: run.assets.map((asset) => ({ ...asset, uploaded: false })) }}
        onStep={() => {}}
      />,
    );
    expect(markup).toContain("Recording upload is incomplete.");
    expect(markup).toContain("Screenshot upload is incomplete.");
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("<img");
  });
  test("unsafe producer schemes cannot become clickable links", () => {
    expect(safeProducerUrl("javascript:alert(1)")).toBeNull();
    expect(safeProducerUrl("https://user:secret@example.com/build")).toBeNull();
    expect(safeProducerUrl("https://github.com/example/repo/actions/runs/1")).toBe(
      "https://github.com/example/repo/actions/runs/1",
    );
  });
});
