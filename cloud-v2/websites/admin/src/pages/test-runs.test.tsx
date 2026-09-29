import { describe, expect, spyOn, test } from "bun:test";
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
import { testRunDetailQuery, TestRunsPage, TestRunView } from "./test-runs";

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

/** Renders a run detail inside the admin query cache that its source lookup uses. */
function renderRun(detail: TestRunDetail, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TestRunView run={detail} onStep={() => {}} />
    </QueryClientProvider>,
  );
}

describe("customer development result presentation", () => {
  function customer(): TestRunDetail {
    return {
      ...structuredClone(run),
      outcome: "passed",
      outcomes: { test: "passed", teardown: "passed", fixture: "ready", evidence: "complete" },
      provenance: { ...run.provenance, executionMode: "manual-supervised",
        qualificationScope: "prepared-customer-development", fullRoutinePassed: "false",
        ciQualified: "false", commissioningPassed: "false" },
      chapters: run.chapters.map(chapter => ({ ...chapter, status: "passed" })),
      firmwareAssertions: run.firmwareAssertions.map(assertion => ({ ...assertion, status: "passed" })),
    };
  }

  test("labels a passed customer phase in list and detail without claiming routine qualification", () => {
    const detail = customer(), before = JSON.stringify(detail);
    const markup = renderRun(detail);
    expect(markup).toContain("Customer phase: passed");
    expect(markup).toContain("Full routine, unattended CI and commissioning are not qualified.");
    expect(markup).not.toContain("stored overall outcome is blocked");
    const client = new QueryClient();
    client.setQueryData(["admin-test-runs", EMPTY_FILTERS, null], {
      pages: [{ runs: [detail], nextCursor: null }], pageParams: [undefined],
    });
    const list = renderToStaticMarkup(<QueryClientProvider client={client}>
      <TestRunsPage selection={null} onSelect={() => {}} />
    </QueryClientProvider>);
    expect(list).toContain("Customer phase: passed");
    expect(list).toContain("Full routine and unattended CI are not qualified.");
    expect(JSON.stringify(detail)).toBe(before);
    client.clear();
  });

  test("explains a historical blocked result without replacing its outcome or failure link", () => {
    const detail = customer();
    detail.outcome = "blocked";
    const occurrenceId = `tfo_${"e".repeat(64)}`;
    detail.failureOccurrences = [{ occurrenceId, delivery: { state: "pending" }, failure: {
      phase: "unknown", step: null, code: "run_blocked", message: "Stored generic failure summary",
      assetIds: [], incidentIds: [], missingEvidence: [], redactionPolicy: "core-generated-summary-v1",
    } }];
    const before = JSON.stringify(detail), markup = renderRun(detail);
    expect(markup).toContain("stored overall outcome is blocked");
    expect(markup).toContain("passed customer test, successful teardown and firmware checks, a ready fixture and complete evidence");
    expect(markup).toContain(`/?fixFlow=${occurrenceId}`);
    expect(markup).toContain("Stored generic failure summary");
    expect(markup).not.toContain("Customer phase: passed");
    expect(JSON.stringify(detail)).toBe(before);
  });

  test("does not explain blocked checks, missing uploads or adverse outcomes as passed", () => {
    const changes: ((value: TestRunDetail) => void)[] = [
      value => { value.outcomes.test = "not-run"; },
      value => { value.outcomes.teardown = "failed"; },
      value => { value.outcomes.fixture = "unavailable"; },
      value => { value.outcomes.evidence = "incomplete"; },
      value => { value.chapters[0].status = "failed"; },
      value => { value.chapters = []; },
      value => { value.firmwareAssertions[0].status = "blocked"; },
      value => { value.firmwareAssertions = []; },
      value => { value.assets[0].uploaded = false; },
      value => { value.outcome = "failed"; },
      value => { value.outcome = "aborted"; },
    ];
    for (const change of changes) {
      const detail = customer(); detail.outcome = "blocked"; change(detail);
      const markup = renderRun(detail);
      expect(markup).toContain("Customer development phase.");
      expect(markup).not.toContain("passed customer test, successful teardown and firmware checks, a ready fixture and complete evidence");
    }
  });

  test("describes recorded outcomes without inventing separate return verification", () => {
    for (const value of [undefined, "failed", "not-run"]) {
      const detail = customer(); detail.outcome = "blocked";
      detail.provenance.returnVerification = value;
      const markup = renderRun(detail);
      expect(markup).toContain("passed customer test, successful teardown and firmware checks, a ready fixture and complete evidence");
      const notice = markup.match(/<aside aria-label="Customer development scope"[^>]*>(.*?)<\/aside>/s)?.[1];
      expect(notice).toBeDefined();
      expect(notice).not.toContain("return checks");
      expect(markup).not.toContain("Customer phase: passed");
    }
  });

  test("does not infer development scope from channel or incomplete and conflicting provenance", () => {
    const keys = ["executionMode", "qualificationScope", "fullRoutinePassed", "ciQualified", "commissioningPassed"];
    for (const key of keys) for (const replacement of [undefined, "true", "unknown"]) {
      const detail = customer(); detail.provenance[key] = replacement;
      const markup = renderRun(detail);
      expect(markup).not.toContain("Customer development scope");
      expect(markup).not.toContain("Customer phase: passed");
    }
    const ordinary = customer(); ordinary.provenance = { ...run.provenance, executionMode: "ci-registered" };
    expect(renderRun(ordinary)).not.toContain("Customer development scope");
  });
});

/** Source lookups this client has registered through the shared detail query. */
function detailLookups(client: QueryClient) {
  return client.getQueryCache().findAll({ queryKey: ["admin-test-run"] }).map((query) => query.queryKey[1]);
}

/** Resolves the existing admin detail lookup into the cache with one synthetic response. */
async function lookUpDetail(client: QueryClient, runId: string, respond: () => Response | Promise<Response>) {
  const fetched = spyOn(globalThis, "fetch").mockImplementation((async () => respond()) as unknown as typeof fetch);
  try {
    await client.prefetchQuery(testRunDetailQuery(runId));
    return fetched.mock.calls.map(([input]) => String(input));
  } finally {
    fetched.mockRestore();
  }
}

// Safe identifiers from a published development recovery and its published original.
const NOTES_ORIGINAL = "notes-phone-f5caf093-76b9-46b4-9de9-7ffe47a1f1db";
const developmentRecovery: TestRunDetail = {
  ...run,
  runId: "recovery-55e2eb0583fe7f68b4844f7cd938056a-2",
  provenance: {
    ...run.provenance,
    executionMode: "development",
    ciQualification: "false",
    resultGeneration: "2",
    originalRunId: NOTES_ORIGINAL,
    previousResultRunId: NOTES_ORIGINAL,
    terminalSnapshotSha256: "bd3ed846b87cef746d7b66fee7ea44a481e90b0cc4a8a9aee263ad638a452f81",
    originalTerminalSnapshotSha256: "e52d77404f3f528f3f7f833f8c223a66d5f03d1c379fed97634cd7308af7225b",
  },
};
const LOCAL_SOURCE = "account-fixed-export-authoring-28c679bd-0383-4978-bea8-d601970dc867";
const localDevelopmentExport: TestRunDetail = {
  ...run,
  runId: "local-account-miniapps-fixed-export-20260926-28c679bd",
  provenance: {
    ...run.provenance,
    executionMode: "development-exploration",
    recoveryOnly: "false",
    ciQualification: "false",
    originalRunId: LOCAL_SOURCE,
  },
};
const publishedDetail = (runId: string) => () => Response.json({ ...run, runId });

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
      const client = new QueryClient();
      const markup = renderRun(recovery, client);
      // Declared CI lineage links directly, exactly as before, without a publication lookup.
      expect(detailLookups(client)).toEqual([]);
      expect(markup).not.toContain("View source result");
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
  test("unresolved development and unknown source IDs are shown as text without navigation or a recovery label", () => {
    const legacy = { ...run, provenance: { ...run.provenance, originalRunId: "recovery-legacy_run-2" } };
    for (const [linked, source] of [
      [localDevelopmentExport, LOCAL_SOURCE],
      [legacy, "recovery-legacy_run-2"],
    ] as const) {
      const client = new QueryClient();
      const markup = renderRun(linked, client);
      expect(relatedRun(linked)).toEqual({ kind: "source", runId: source });
      // Only the exact source is looked up; until it resolves the reference stays text.
      expect(detailLookups(client)).toEqual([source]);
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
      const markup = renderRun(linked);
      expectSourceReference(markup, "original_run-01");
      expect(markup).not.toContain("Recovery result");
    }
  });
  test("a published development original links through the existing detail lookup", async () => {
    expect(relatedRun(developmentRecovery)).toEqual({ kind: "source", runId: NOTES_ORIGINAL });
    const client = new QueryClient();
    expectSourceReference(renderRun(developmentRecovery, client), NOTES_ORIGINAL);
    expect(detailLookups(client)).toEqual([NOTES_ORIGINAL]);

    const requests = await lookUpDetail(client, NOTES_ORIGINAL, publishedDetail(NOTES_ORIGINAL));
    expect(requests).toEqual([`/api/admin/test-runs/${NOTES_ORIGINAL}`]);
    const markup = renderRun(developmentRecovery, client);
    const aside = markup.match(/<aside aria-label="Source reference"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
    expect(aside).toContain(`<code class="break-all font-mono text-xs">${NOTES_ORIGINAL}</code>`);
    expect(aside).toContain(`<a href="/?testRun=${NOTES_ORIGINAL}"`);
    expect(aside).toContain(">View source result</a>");
    expect(aside).not.toContain("It may not be a published result.");
    expect(markup.match(/href="\/\?testRun=[^"]*"/g)).toEqual([`href="/?testRun=${NOTES_ORIGINAL}"`]);
    // The development result stays a neutral source reference with its own recorded outcomes.
    expect(markup).not.toContain("Recovery result");
    expect(markup).not.toContain("View original run");
    expect(markup).toMatch(/>test<\/p>[\s\S]*?>failed<\/span>/);
    expect(markup).toMatch(/>teardown<\/p>[\s\S]*?>passed<\/span>/);
    expect(markup).toContain("<dt class=\"text-xs font-medium text-[#747780]\">executionMode</dt>");
  });
  test("an unpublished or unavailable source stays text and its lookup error does not reach the page", async () => {
    for (const respond of [
      () => Response.json({ message: "Test run not found" }, { status: 404, statusText: "Not Found" }),
      () => Response.json({ message: "Upstream unavailable" }, { status: 503, statusText: "Service Unavailable" }),
      () => Promise.reject(new TypeError("Network request failed")),
      // A response for another run is not a resolution of this source.
      publishedDetail("different-run"),
    ]) {
      const client = new QueryClient();
      expect(await lookUpDetail(client, LOCAL_SOURCE, respond)).toEqual([`/api/admin/test-runs/${LOCAL_SOURCE}`]);
      const markup = renderRun(localDevelopmentExport, client);
      expectSourceReference(markup, LOCAL_SOURCE);
      for (const leaked of ["not found", "Upstream unavailable", "Network request failed", "different-run", 'role="alert"'])
        expect(markup).not.toContain(leaked);
      expect(markup).toMatch(/>test<\/p>[\s\S]*?>failed<\/span>/);
    }
  });
  test("a resolved target for another source or result cannot appear as a stale link", async () => {
    const client = new QueryClient();
    await lookUpDetail(client, NOTES_ORIGINAL, publishedDetail(NOTES_ORIGINAL));
    // Switching to a result with a different, unresolved source must not reuse the published target.
    const local = renderRun(localDevelopmentExport, client);
    expectSourceReference(local, LOCAL_SOURCE);
    expect(local).not.toContain(NOTES_ORIGINAL);
    // A cache entry whose record is another run cannot link this source either.
    client.setQueryData(testRunDetailQuery(LOCAL_SOURCE).queryKey, { ...run, runId: NOTES_ORIGINAL });
    const mismatched = renderRun(localDevelopmentExport, client);
    expectSourceReference(mismatched, LOCAL_SOURCE);
    expect(mismatched).not.toContain(NOTES_ORIGINAL);
    // Returning to the published source links only that exact target.
    const published = renderRun(developmentRecovery, client);
    expect(published.match(/href="\/\?testRun=[^"]*"/g)).toEqual([`href="/?testRun=${NOTES_ORIGINAL}"`]);
    expect(detailLookups(client).sort()).toEqual([LOCAL_SOURCE, NOTES_ORIGINAL].sort());
  });
  test("only valid distinct original run IDs produce a linked run or a lookup", () => {
    const fetched = spyOn(globalThis, "fetch");
    try {
      for (const base of [run, ciRecovery, amendedCiRecovery, coreRecovery, developmentRecovery]) {
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
          const client = new QueryClient();
          const markup = renderRun(linked, client);
          expect(relatedRun(linked)).toBeNull();
          expect(detailLookups(client)).toEqual([]);
          expect(markup).not.toContain('aria-label="Recovery result"');
          expect(markup).not.toContain('aria-label="Source reference"');
          expect(markup).not.toContain("View original run");
          expect(markup).not.toContain("/?testRun=");
        }
      }
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
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

describe("worker preparation failures", () => {
  // Synthetic render fixture shaped as the private producer's not-run result as Core presents it.
  const failure = {
    phase: "preflight" as const,
    step: { id: "intake-fixture-readiness", label: "Worker intake stage: fixture-readiness" },
    code: "fixture-return-verification-missing",
    message: "Ready fixture lacks its original completed return-verification journal",
    assetIds: [],
    incidentIds: [],
    redactionPolicy: "reviewed-preparation-diagnostic-v1",
    missingEvidence: [
      { kind: "recording", reason: "No device operation ran, so no recording exists." },
      { kind: "incident", reason: "No incident is filed for a worker preparation failure." },
    ],
  };
  const stopped: TestRunDetail = {
    ...run,
    runId: "routine-200-1-dev-day1-ota-prep-36415118681-1",
    requestId: "routine-200-1-dev-day1-ota",
    routineId: "day1-ota",
    channel: "dev",
    outcome: "blocked",
    outcomes: { test: "not-run", teardown: "not-run", fixture: "unknown", evidence: "incomplete" },
    provenance: {
      repository: "Mentra-Community/MentraOS",
      intakeStatus: "preparation-blocked",
      intakeStage: "fixture-readiness",
      claim: "not-attempted",
      hardwareStarted: "false",
      privateRepository: "Mentra-Community/Mentra-Automated-Testing",
      privateRunId: "36415118681",
      privateRunAttempt: "1",
      requestUrl: "https://github.com/Mentra-Community/MentraOS/actions/runs/36415005043/attempts/1",
    },
    fixture: { alias: "unallocated" },
    firmwareAssertions: [],
    chapters: [],
    assets: [],
    failures: [failure],
    failureOccurrences: [{ occurrenceId: `tfo_${"a".repeat(64)}`, failure, delivery: { state: "pending" } }],
  };

  test("shows the stage, not-run test, recorded hardware state, evidence gaps, delivery and exact links", () => {
    const markup = renderRun(stopped);
    expect(markup).toContain("Failure details");
    expect(markup).toContain("The worker stopped at intake stage fixture-readiness.");
    expect(markup).toContain("recorded that hardware was not started");
    expect(markup).toContain("No claim requested.");
    expect(markup).toContain("Ready fixture lacks its original completed return-verification journal");
    expect(markup).toContain("fixture-return-verification-missing");
    expect(markup).toContain("Preflight · Worker intake stage: fixture-readiness");
    expect(markup).toContain("Delivery for investigation pending");
    expect(markup).toContain("Missing evidence (2)");
    expect(markup).toContain("No device operation ran, so no recording exists.");
    expect(markup).toContain('href="https://github.com/Mentra-Community/MentraOS/actions/runs/36415005043/attempts/1"');
    expect(markup).toContain('href="https://github.com/Mentra-Community/Mentra-Automated-Testing/actions/runs/36415118681/attempts/1"');
    const acknowledged = renderRun({
      ...stopped,
      failureOccurrences: [{ occurrenceId: `tfo_${"a".repeat(64)}`, failure,
        delivery: { state: "acknowledged", agentRunId: "agent-1", acknowledgedAt: "2026-09-28T12:00:00Z" } }],
    });
    expect(acknowledged).toContain("Delivered for investigation");
    expect(renderRun({ ...stopped, provenance: { ...stopped.provenance, claim: "not-granted", intakeStatus: "claim-blocked" } }))
      .toContain("Claim not granted.");
  });

  test("names the claim only from the recorded value that matches its intake status", () => {
    const claimText = (intakeStatus: string, claim?: string) => {
      const { claim: _omit, ...rest } = stopped.provenance;
      return renderRun({ ...stopped, provenance: { ...rest, intakeStatus, ...(claim === undefined ? {} : { claim }) } });
    };
    // The producer's two explicit pairs keep their known labels; only that label speaks about the claim.
    for (const [intakeStatus, claim, label] of [["preparation-blocked", "not-attempted", "No claim requested"],
      ["claim-blocked", "not-granted", "Claim not granted"]] as const) {
      const markup = claimText(intakeStatus, claim);
      expect(markup).toContain("The worker stopped at intake stage fixture-readiness.");
      expect(markup).toContain(`${label}.`);
      expect(markup).not.toContain("before any claim");
    }
    // Missing, unrecognized or mismatched provenance proves neither.
    for (const [intakeStatus, claim] of [
      ["preparation-blocked", undefined], ["claim-blocked", undefined],
      ["preparation-blocked", "granted"], ["claim-blocked", "unknown-value"],
      ["preparation-blocked", "not-granted"], ["claim-blocked", "not-attempted"],
    ] as const) {
      const markup = claimText(intakeStatus, claim);
      // A neutral heading from the recorded stage only: no claim is asserted anywhere in the summary.
      expect(markup).toContain("The worker stopped at intake stage fixture-readiness.");
      expect(markup).toContain("Claim state not recorded.");
      expect(markup).not.toContain("before any claim");
      expect(markup).not.toContain("No claim requested");
      expect(markup).not.toContain("Claim not granted");
    }
  });

  test("the stop summary asserts nothing about the fixture; recorded fixture and firmware observations still render", () => {
    // Schema-valid results whose fixture outcome and firmware checks were recorded: the summary must not contradict them.
    for (const fixtureOutcome of ["ready", "unavailable"] as const) {
      const markup = renderRun({
        ...stopped,
        outcomes: { ...stopped.outcomes, fixture: fixtureOutcome },
        firmwareAssertions: [{ component: "MTK", expected: "20260921.0", actual: "20260113.0", status: "failed", phase: "preflight" }],
      });
      expect(markup).not.toContain("no fixture state");
      expect(markup).not.toContain("fixture state was observed");
      expect(markup).toContain("The worker stopped at intake stage fixture-readiness.");
      expect(markup).toContain("No claim requested.");
      // The existing outcome grid and firmware table show what was recorded.
      expect(markup).toMatch(new RegExp(`>fixture</p><span[^>]*>${fixtureOutcome}</span>`));
      expect(markup).toContain(">MTK</th>");
      expect(markup).toContain("20260921.0");
      expect(markup).toContain("20260113.0");
    }
    expect(renderRun(stopped)).not.toContain("no fixture state");
  });

  test("never builds links from unvalidated values and never infers a stop the worker did not record", () => {
    const unsafe = renderRun({
      ...stopped,
      provenance: { ...stopped.provenance, requestUrl: "javascript:alert(1)", privateRunId: "1/../../x", privateRepository: "someone/else" },
    });
    // The provenance table still prints recorded values as text; no link is built from them.
    expect(unsafe).not.toContain('href="javascript:');
    expect(unsafe).not.toContain("someone/else/actions");
    expect(unsafe).not.toMatch(/<a [^>]*>Request<\/a>/);
    expect(unsafe).not.toContain("Worker attempt");
    for (const change of [{ hardwareStarted: undefined }, { hardwareStarted: "true" }, { intakeStatus: "terminal" }, { intakeStage: "Bad Stage" }]) {
      const markup = renderRun({ ...stopped, provenance: { ...stopped.provenance, ...change } });
      expect(markup).not.toContain("The worker stopped at intake stage");
      // The failure itself stays visible.
      expect(markup).toContain("fixture-return-verification-missing");
    }
    expect(renderRun({ ...stopped, outcomes: { ...stopped.outcomes, test: "failed" } })).not.toContain("The worker stopped at intake stage");
  });

  test("legacy results render unchanged or with failures but no invented delivery state", () => {
    expect(renderRun(run)).not.toContain("Failure details");
    const legacy = renderRun({ ...run, failures: [failure] });
    expect(legacy).toContain("Failure details");
    expect(legacy).toContain("No delivery state recorded");
    expect(legacy).not.toContain("The worker stopped at intake stage");
  });
});
