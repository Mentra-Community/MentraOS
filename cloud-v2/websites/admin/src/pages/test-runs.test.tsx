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
  relatedRun,
  runDuration,
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

// Synthetic ordinary appended CI recovery shaped like the registered CI exporter's
// provenance: a same-definition recovery has no amendment hashes.
const ciRecovery: TestRunDetail = {
  ...run,
  runId: "recovery-2",
  channel: "dev",
  provenance: {
    ...run.provenance,
    executionMode: "ci-registered",
    requestRelationship: "consumed",
    resultGeneration: "2",
    terminalSnapshotSha256: "1".repeat(64),
    originalTerminalSnapshotSha256: "2".repeat(64),
    originalRunId: "original_run-01",
    previousResultRunId: "original_run-01",
  },
};
// The same recovery after a recoveryRef amendment, which adds amendment lineage.
const amendedCiRecovery: TestRunDetail = {
  ...ciRecovery,
  runId: "recovery-3",
  provenance: {
    ...ciRecovery.provenance,
    resultGeneration: "3",
    previousResultRunId: "recovery-2",
    recoveryRevisionSha256: "3".repeat(64),
    recoveryHistorySha256: "4".repeat(64),
  },
};
// Mirrors Core's supported recovery() fixture in test-run-overview.service.test.ts,
// which carries no previousResultRunId.
const coreRecovery: TestRunDetail = {
  ...run,
  runId: "recovery-2",
  channel: "dev",
  outcomes: { test: "failed", teardown: "passed", fixture: "ready", evidence: "incomplete" },
  provenance: {
    repository: "Mentra-Community/MentraOS",
    requestSha256: "a".repeat(64),
    executionMode: "ci-registered",
    requestRelationship: "consumed",
    resultGeneration: "2",
    archiveSha256: "c".repeat(64),
    originalRunId: "original",
    originalTerminalSnapshotSha256: "b".repeat(64),
    terminalSnapshotSha256: "d".repeat(64),
    returnVerification: "passed",
  },
};

/** A source reference keeps its safe ID as text and never navigates to it. */
function expectSourceReference(markup: string, source: string) {
  const aside = markup.match(/<aside aria-label="Source reference"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
  expect(aside).toBeDefined();
  expect(aside).toContain(`<code class="break-all font-mono text-xs">${source}</code>`);
  expect(aside).toContain("It may not be a published result.");
  expect(aside).not.toMatch(/<(a|button)[\s>]/);
  expect(markup).not.toContain("/?testRun=");
  expect(markup).not.toContain("View original run");
}

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
  for (const channel of ["dev", "staging"] as const) {
    test(`${channel} Slack results link opens the exact coordinated build through login and navigation`, async () => {
      const { coordinatedRoutineLinks } = await import(
        new URL("../../../../../.github/scripts/coordinated-downloads-slack.mjs", import.meta.url).href
      );
      const { coordinatedFixture } = await import(
        new URL("../../../../../.github/scripts/coordinated-routine-fixture.mjs", import.meta.url).href
      );
      const { state, options } = coordinatedFixture(channel);
      const blocks = await coordinatedRoutineLinks({
        BRANCH: channel, RELEASE_SCOPE: "core", FINALIZE_RESULT: "success", RELEASE_PAGE_RESULT: "success",
        EXAMPLES_DISPATCH_RESULT: "success", RELEASE_IDENTITY: state.plan.releaseIdentity,
        REPOSITORY: "Mentra-Community/MentraOS", SHA: state.plan.sourceCommit, RUN_ID: "100", RUN_ATTEMPT: "2",
        MAC_URL: state.receipt.app.otaManifestUrl.replace(state.plan.artifactNames.otaManifest, state.receipt.artifacts.mac.name),
      }, options.fetchImpl);
      const location = blocks[0].text.text.match(/<(https:\/\/admin\.dev\.[^|]+)\|/)[1];
      const login = new URL("/api/console/auth/login", location);
      login.searchParams.set("return_to", location);
      const returned = new URL(login.searchParams.get("return_to")!);
      const scope = readTestRunListScope(returned.search);
      const expectedScope = {
        channel, repository: "Mentra-Community/MentraOS", headSha: state.plan.sourceCommit,
        archiveSha256: state.receipt.artifacts.mac.sha256, routineId: "no-glasses", platform: "ios-mac",
      } as const;
      expect(scope).toEqual(expectedScope);
      const detail = new URL(testRunLocation(returned.href, { runID: "synthetic-coordinated-run" }), returned);
      expect(readTestRunListScope(detail.search)).toEqual(scope);
      const back = new URL(testRunLocation(detail.href, null), returned);
      expect(readTestRunListScope(back.search)).toEqual(scope);
      expect(testRunListLocation(back.href, null)).toBe("/");
      const path = new URL(testRunListPath({
        ...EMPTY_FILTERS, pr: "4136", channel: "pr", routineId: "other", platform: "android", outcome: "failed",
      }, "next-page", scope), returned);
      expect(Object.fromEntries(path.searchParams)).toEqual({ ...expectedScope, outcome: "failed", limit: "25", cursor: "next-page" });
      const client = new QueryClient();
      client.setQueryData(["admin-test-runs", EMPTY_FILTERS, scope], { pages: [{ runs: [], nextCursor: null }], pageParams: [undefined] });
      const markup = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <TestRunsPage selection={null} onSelect={() => {}} scope={scope} onClearScope={() => {}} />
        </QueryClientProvider>,
      );
      expect(markup).toContain(channel === "dev" ? "Dev build" : "Staging build");
      expect(markup).not.toContain("PR #");
      expect(markup).toContain("No results for this build yet");
      expect(markup).toContain(state.receipt.artifacts.mac.sha256);
      expect(markup).toMatch(/disabled=""[^>]*aria-label="PR number"/);
      expect(markup).toMatch(new RegExp(`<option value="${channel}" selected=""`));
      client.clear();
    });
  }
  test("exact build scope survives login, detail navigation and back to results", () => {
    const location = `https://admin.dev.mentraglass.com/?${buildQuery}`;
    const login = new URL("/api/console/auth/login", location);
    login.searchParams.set("return_to", location);
    const returned = new URL(login.searchParams.get("return_to")!);
    const scope = readTestRunListScope(returned.search)!;
    if (scope.channel !== "pr") throw new Error("Legacy PR link must retain its PR scope");
    expect(scope).toEqual({
      channel: "pr",
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
  test("coordinated scopes require one channel, all build pins and no PR selector", () => {
    for (const channel of ["dev", "staging"]) {
      const coordinated = new URLSearchParams(buildQuery);
      coordinated.delete("pr");
      coordinated.set("channel", channel);
      for (const key of [...coordinated.keys()]) {
        const missing = new URLSearchParams(coordinated);
        missing.delete(key);
        expect(readTestRunListScope(missing.toString())).toBeNull();
        const duplicate = new URLSearchParams(coordinated);
        duplicate.append(key, coordinated.get(key)!);
        expect(readTestRunListScope(duplicate.toString())).toBeNull();
      }
      for (const value of ["", "4136"]) {
        const mixed = new URLSearchParams(coordinated);
        mixed.set("pr", value);
        expect(readTestRunListScope(mixed.toString())).toBeNull();
      }
      for (const value of ["", "pr", "local", "production", "beta"]) {
        const invalid = new URLSearchParams(coordinated);
        invalid.set("channel", value);
        expect(readTestRunListScope(invalid.toString())).toBeNull();
      }
    }
    const explicitPr = new URLSearchParams(buildQuery);
    explicitPr.set("channel", "pr");
    expect(readTestRunListScope(explicitPr.toString())).toEqual(readTestRunListScope(buildQuery.toString()));
    explicitPr.append("channel", "pr");
    expect(readTestRunListScope(explicitPr.toString())).toBeNull();
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
    for (const id of ["..", "../other", "https://elsewhere.invalid/video", "a/b", "a\\b", "%2F", "asset.1"]) {
      expect(() => testRunAssetPath("run-one", id)).toThrow();
    }
    expect(readTestRunLink("?testRun=run.1&step=AUTH-08.1")).toBeNull();
    expect(() => testRunAssetPath("run.1", "asset_one")).toThrow();
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
  test("dotted login chapter links survive authentication and select the exact recorded step", () => {
    const chapters = ["AUTH-08.1", "AUTH-08.2", "AUTH-08.3"].map((id, index) => ({
      ...run.chapters[0], id, instruction: `Login action ${id}`, videoStart: index * 2, videoEnd: index * 2 + 1,
    }));
    for (const chapter of chapters) {
      const current = "https://admin.dev.mentraglass.com/";
      const location = new URL(testRunLocation(current, { runID: run.runId, stepID: chapter.id }), current);
      const login = new URL("/api/console/auth/login", current);
      login.searchParams.set("return_to", location.href);
      const returned = new URL(login.searchParams.get("return_to")!);
      const selection = readTestRunLink(returned.search);
      expect(selection).toEqual({ runID: run.runId, stepID: chapter.id });
      expect(initialChapter(chapters, selection!.stepID)).toEqual(chapter);
      expect(chapterSeekTime(chapter, run.assets[0], 10)).toBe(chapter.videoStart);
      const markup = renderToStaticMarkup(
        <TestRunView run={{ ...run, chapters }} stepId={selection!.stepID} onStep={() => {}} />,
      );
      expect(markup).toContain(chapter.id);
      expect(markup).toContain(`<h4 class="text-sm font-semibold">${chapter.instruction}</h4>`);
      expect(markup).not.toContain("The linked step was not found");
      expect(markup).toContain('aria-current="step"');
      expect(markup).toContain('src="/api/admin/test-runs/synthetic-run/assets/video-one"');
    }
  });
  test("paired recordings use the shared viewer while malformed mappings retain independent playback", () => {
    const browser = { ...run.assets[0], assetId: "browser-recording", filename: "browser.mp4" };
    const paired = { ...run, assets: [...run.assets, browser], provenance: { ...run.provenance, recordingTimeline: JSON.stringify({
      schemaVersion: 1, clock: "native-video", uncertaintyMs: 75, tracks: [
        { assetId: "video-one", label: "Mentra App", offsetSeconds: 0 },
        { assetId: "browser-recording", label: "Browser peer", offsetSeconds: 2 },
      ],
    }) } };
    const markup = renderToStaticMarkup(<TestRunView run={paired} onStep={() => {}} />);
    expect(markup).toContain('aria-label="Synchronized routine recordings"');
    expect(markup).toContain('aria-label="Browser peer recording"');
    const invalid = renderToStaticMarkup(<TestRunView run={{ ...paired, provenance: { ...paired.provenance, recordingTimeline: "invalid" } }} onStep={() => {}} />);
    expect(invalid).toContain("Showing the selected recording independently");
    expect(invalid).not.toContain('aria-label="Synchronized routine recordings"');
    expect(invalid).toContain('aria-label="Routine recording"');
  });
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
  test("links ordinary and amended CI recoveries to the original run while retaining the failed test outcome", () => {
    expect(ciRecovery.provenance.recoveryRevisionSha256).toBeUndefined();
    expect(ciRecovery.provenance.recoveryHistorySha256).toBeUndefined();
    for (const recovery of [ciRecovery, amendedCiRecovery]) {
      const markup = renderToStaticMarkup(<TestRunView run={recovery} onStep={() => {}} />);
      expect(relatedRun(recovery)).toEqual({ kind: "recovery", runId: "original_run-01" });
      expect(markup).toContain('aria-label="Recovery result"');
      expect(markup).toContain('href="/?testRun=original_run-01"');
      expect(markup).toContain("The original test outcome is preserved.");
      expect(markup).not.toContain('aria-label="Source reference"');
      expect(markup).toMatch(/>test<\/p>[\s\S]*?>failed<\/span>/);
      expect(markup).toMatch(/>fixture<\/p>[\s\S]*?>ready<\/span>/);
    }
  });
  test("Core-shaped and failed recoveries stay recoveries without previous-result metadata", () => {
    expect(coreRecovery.provenance.previousResultRunId).toBeUndefined();
    const failedAttempt: TestRunDetail = {
      ...coreRecovery,
      outcomes: { test: "failed", teardown: "failed", fixture: "unavailable", evidence: "incomplete" },
      provenance: { ...coreRecovery.provenance, returnVerification: "failed" },
    };
    for (const [recovery, outcomes] of [
      [coreRecovery, [["teardown", "passed"], ["fixture", "ready"]]],
      [failedAttempt, [["teardown", "failed"], ["fixture", "unavailable"]]],
    ] as const) {
      const markup = renderToStaticMarkup(<TestRunView run={recovery} onStep={() => {}} />);
      expect(relatedRun(recovery)).toEqual({ kind: "recovery", runId: "original" });
      expect(markup).toContain('aria-label="Recovery result"');
      expect(markup).toContain('href="/?testRun=original"');
      expect(markup).not.toContain('aria-label="Source reference"');
      expect(markup).toMatch(/>test<\/p>[\s\S]*?>failed<\/span>/);
      for (const [label, value] of outcomes)
        expect(markup).toMatch(new RegExp(`>${label}</p>[\\s\\S]*?>${value}</span>`));
    }
    // The optional previous result is not the displayed link and cannot decide the label.
    for (const previousResultRunId of [undefined, ciRecovery.runId, "../other", "\ud800"]) {
      const linked = { ...ciRecovery, provenance: { ...ciRecovery.provenance, previousResultRunId } };
      expect(relatedRun(linked)).toEqual({ kind: "recovery", runId: "original_run-01" });
      const markup = renderToStaticMarkup(<TestRunView run={linked} onStep={() => {}} />);
      expect(markup).toContain('aria-label="Recovery result"');
      expect(markup.match(/href="\/\?testRun=[^"]*"/g)).toEqual(['href="/?testRun=original_run-01"']);
    }
  });
  test("development and unknown source IDs are shown as text without navigation or a recovery label", () => {
    const development = {
      ...run,
      runId: "local-account-miniapps-fixed-export-20260926-28c679bd",
      provenance: {
        ...run.provenance,
        executionMode: "development-exploration",
        recoveryOnly: "false",
        ciQualification: "false",
        originalRunId: "account-fixed-export-authoring-28c679bd-0383-4978-bea8-d601970dc867",
      },
    };
    const legacy = { ...run, provenance: { ...run.provenance, originalRunId: "recovery-legacy_run-2" } };
    for (const [linked, source] of [
      [development, "account-fixed-export-authoring-28c679bd-0383-4978-bea8-d601970dc867"],
      [legacy, "recovery-legacy_run-2"],
    ] as const) {
      const markup = renderToStaticMarkup(<TestRunView run={linked} onStep={() => {}} />);
      expect(relatedRun(linked)).toEqual({ kind: "source", runId: source });
      expectSourceReference(markup, source);
      expect(markup).not.toContain("Recovery result");
      expect(markup).not.toContain("original test outcome");
      expect(markup).toMatch(/>test<\/p>[\s\S]*?>failed<\/span>/);
      expect(markup).toMatch(/>teardown<\/p>[\s\S]*?>passed<\/span>/);
    }
  });
  test("incomplete or malformed CI lineage is an unlinked source reference, never a recovery", () => {
    for (const provenance of [
      { ...ciRecovery.provenance, executionMode: undefined },
      { ...ciRecovery.provenance, executionMode: "development-exploration" },
      { ...ciRecovery.provenance, requestRelationship: "unrelated" },
      { ...ciRecovery.provenance, resultGeneration: "1" },
      { ...ciRecovery.provenance, resultGeneration: "02" },
      { ...ciRecovery.provenance, resultGeneration: "2.5" },
      { ...ciRecovery.provenance, resultGeneration: "9".repeat(20) },
      { ...amendedCiRecovery.provenance, originalTerminalSnapshotSha256: "E".repeat(64) },
      { ...ciRecovery.provenance, originalTerminalSnapshotSha256: "" },
      { ...ciRecovery.provenance, terminalSnapshotSha256: "not-a-digest" },
    ]) {
      const linked = { ...ciRecovery, provenance };
      expect(relatedRun(linked)).toEqual({ kind: "source", runId: "original_run-01" });
      const markup = renderToStaticMarkup(<TestRunView run={linked} onStep={() => {}} />);
      expectSourceReference(markup, "original_run-01");
      expect(markup).not.toContain("Recovery result");
    }
  });
  test("only valid distinct original run IDs produce a linked run", () => {
    for (const base of [run, ciRecovery, amendedCiRecovery, coreRecovery]) {
      for (const originalRunId of [
        undefined,
        base.runId,
        "../other",
        "https://elsewhere.invalid",
        "one&testRun=two",
        "\ud800",
        "a".repeat(121),
      ]) {
        const linked = { ...base, provenance: { ...base.provenance, originalRunId } };
        const markup = renderToStaticMarkup(<TestRunView run={linked} onStep={() => {}} />);
        expect(relatedRun(linked)).toBeNull();
        expect(markup).not.toContain('aria-label="Recovery result"');
        expect(markup).not.toContain('aria-label="Source reference"');
        expect(markup).not.toContain("View original run");
        expect(markup).not.toContain("/?testRun=");
      }
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

describe("recorded run duration", () => {
  test("uses only the recorded start and finish and never fabricates a value", () => {
    expect(runDuration("2026-09-22T01:00:00Z", "2026-09-22T01:10:00Z")).toBe("10m 0s");
    expect(runDuration("2026-09-22T01:00:00Z", "2026-09-22T01:00:42.900Z")).toBe("42s");
    expect(runDuration("2026-09-22T01:00:00Z", "2026-09-22T03:05:30Z")).toBe("2h 5m");
    expect(runDuration("2026-09-22T01:00:00Z", "2026-09-22T01:00:00Z")).toBe("0s");
    expect(runDuration("2026-09-22T01:00:00Z", "2026-09-22T01:00:00.250Z")).toBe("<1s");
    for (const [start, finish] of [
      ["2026-09-22T01:10:00Z", "2026-09-22T01:00:00Z"],
      ["not a time", "2026-09-22T01:00:00Z"],
      ["2026-09-22T01:00:00Z", ""],
      [undefined, "2026-09-22T01:00:00Z"],
      ["2026-09-22T01:00:00Z", null],
      [Number.POSITIVE_INFINITY, Number.NaN],
    ])
      expect(runDuration(start, finish)).toBeNull();
  });

  test("history rows show each run's duration beside its date and keep filters", () => {
    const client = new QueryClient();
    const rows = [
      { ...run, runId: "synthetic-complete" },
      { ...run, runId: "synthetic-zero", finishedAt: run.startedAt },
      { ...run, runId: "synthetic-reversed", startedAt: "2026-09-22T02:00:00Z" },
      { ...run, runId: "synthetic-missing", finishedAt: undefined as unknown as string },
    ];
    client.setQueryData(["admin-test-runs", EMPTY_FILTERS, null], { pages: [{ runs: rows, nextCursor: null }], pageParams: [undefined] });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TestRunsPage selection={null} onSelect={() => {}} />
      </QueryClientProvider>,
    );
    const texts = [...markup.matchAll(/<p class="mt-1 text-xs text-\[#747780\]">(.*?)<\/p>/g)].map((match) => match[1]);
    expect(texts).toHaveLength(4);
    expect(texts[0]).toMatch(/2026.* · Took 10m 0s$/);
    expect(texts[1]).toMatch(/ · Took 0s$/);
    expect(texts[2]).toMatch(/ · Duration not available$/);
    expect(texts[3]).toMatch(/ · Duration not available$/);
    expect(markup).not.toContain("NaN");
    expect(markup).toContain('aria-label="Fixture alias"');
    expect(markup).toContain("Apply filters");
  });

  test("run detail shows the recorded duration or states it is unavailable", () => {
    const valid = renderToStaticMarkup(<TestRunView run={run} onStep={() => {}} />);
    expect(valid).toMatch(/<dt[^>]*>Duration<\/dt><dd[^>]*>10m 0s<\/dd>/);
    const reversed = renderToStaticMarkup(
      <TestRunView run={{ ...run, finishedAt: "2026-09-22T00:00:00Z" }} onStep={() => {}} />,
    );
    expect(reversed).toMatch(/<dt[^>]*>Duration<\/dt><dd[^>]*>Not available from the recorded times<\/dd>/);
    expect(reversed).not.toContain("NaN");
  });
});
