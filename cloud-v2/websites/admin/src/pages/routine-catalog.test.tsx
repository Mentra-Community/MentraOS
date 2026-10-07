import {testRoutineSource, testFrameworkBinding} from "../../../../packages/core/src/testing/framework-fixtures"
import {expect, test} from "bun:test"
import {renderToStaticMarkup} from "react-dom/server"
import {QueryClient, QueryClientProvider} from "@tanstack/react-query"
import {
  FrameworkRunPage,
  FrameworkRunsPage,
  RoutineCatalogCard,
  RoutineCatalogList,
  frameworkRunHref,
  frameworkRunRefetchInterval,
  routineHref,
  matchesCatalogSearch,
  matchesHistorySearch,
  matchesStepSearch,
  recordingOffset,
  testHistoryListPath,
} from "./routine-catalog"
import {RoutineSearch, EMPTY_ROUTINE_FILTERS} from "../components/routine-search"
import type {TestHistoryEntry} from "../../../../packages/core/src/types/test-history.types"
import {readTestRunLink} from "../lib/test-run-links"
import {routineEnrollmentSchema} from "../../../../packages/core/src/types/routine-definition.types"
import {frameworkRunSchema, recordedFrameworkRunSchema} from "../../../../packages/core/src/types/framework-run.types"

const routine = routineEnrollmentSchema.parse({
  routineId: "notes-phone",
  platform: "ios-on-mac",
  definitionRevision: "c".repeat(40),
  definitionSha256: "d".repeat(64),
  routineSource: testRoutineSource("c".repeat(40)),
  definition: {
    minimumRoutineApiVersion: 1,
    id: "notes-phone",
    title: "Notes",
    purpose: "Create and find a note",
    platforms: ["ios-on-mac"],
    entry: "home",
    account: "lane",
    requires: [],
    requirements: [],
    fixtures: [],
    steps: [{id: "create", instruction: "Create a note", expected: "Note saved"}],
    source: {
      repository: "Mentra-Community/Mentra-Automated-Testing",
      revision: "c".repeat(40),
      path: "routines/notes-phone/routine.ts",
    },
  },
})

test('historical recorded runs render unknown provenance without fabricating identities', () => {
  const run = recordedFrameworkRunSchema.parse({schemaVersion: 1, requestId: 'historical-run', hostId: 'mini', routineId: 'notes-phone',
    definitionRevision: 'c'.repeat(40), platform: 'ios-on-mac', laneId: 'mac',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-03T19:00:00Z', finishedAt: '2026-10-03T19:01:00Z', assets: [],
    result: {runId: 'historical-run', finishedAt: '2026-10-03T19:01:00Z', setup: {status: 'passed'}, test: 'passed',
      steps: [{id: 'observe', status: 'passed', durationMs: 1}], teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [], evidence: [], timing: {startedAt: '2026-10-03T19:00:00Z', setupMs: 0, testMs: 1, teardownMs: 0}}})
  const client = new QueryClient()
  client.setQueryData(['framework-run', run.requestId], {run, definition: null, outcome: 'pass', uploadsComplete: true, evidenceStatus: 'complete'})
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunPage runId={run.requestId}/></QueryClientProvider>)
  expect(html).toContain('Framework provenance unknown')
  expect(html).toContain('Routine bundle provenance unknown')
  expect(html).not.toContain('Routine API 1')
  expect(run).not.toHaveProperty('routineSource')
  expect(run).not.toHaveProperty('frameworkBinding')
})

test('historical request display explicitly reports missing routine archive provenance', () => {
  const client = new QueryClient()
  client.setQueryData(['framework-run', 'old-request'], {kind: 'request', request: {requestId: 'old-request', hostId: 'mini',
    inputSha256: 'd'.repeat(64), routineId: 'old-product', definitionRevision: 'a'.repeat(40), platform: 'android', laneId: 'phone', state: 'terminal', terminalStatus: 'not-run',
    build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)}}})
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunPage runId='old-request'/></QueryClientProvider>)
  expect(html).toContain('Routine bundle provenance unknown')
  expect(html).not.toContain('Requires routine API')
})

test("catalog search combines title or description substrings with exact platform and declared glasses models", () => {
  const connected = {
    ...routine,
    platform: "android" as const,
    definition: {...routine.definition, glasses: {models: ["mentra-live", "even-g1"]}},
  }
  expect(matchesCatalogSearch(routine, "  OTE  ", "ios-on-mac", "no-glasses")).toBe(true)
  expect(matchesCatalogSearch(routine, "FIND A", "", "")).toBe(true)
  expect(matchesCatalogSearch(routine, "login", "", "")).toBe(false)
  expect(matchesCatalogSearch(routine, "notes", "android", "")).toBe(false)
  expect(matchesCatalogSearch(routine, "", "", "mentra-live")).toBeFalsy()
  expect(matchesCatalogSearch(connected, "note", "android", "mentra-live")).toBe(true)
  expect(matchesCatalogSearch(connected, "", "", "even-g1")).toBe(true)
  expect(matchesCatalogSearch(connected, "", "", "no-glasses")).toBe(false)
  expect(matchesCatalogSearch(connected, "", "", "mentra")).toBe(false)
  expect(matchesCatalogSearch(routine, "   ", "", "")).toBe(true)
})

test("catalog filter controls derive options from the whole catalog and retain cards and nightly switches", () => {
  const client = new QueryClient()
  client.setQueryData(["routine-catalog"], {
    routines: [
      {...routine, example: null},
      {
        ...routine,
        platform: "android",
        definition: {...routine.definition, glasses: {models: ["mentra-live", "even-g1"]}},
        example: null,
      },
    ],
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RoutineCatalogList />
    </QueryClientProvider>,
  )
  expect(html).toContain('role="search" aria-label="Search routines"')
  expect(html).toContain('type="search"')
  expect(html).toContain('placeholder="Name or description"')
  for (const label of [
    "All platforms",
    "Android",
    "iOS on Mac",
    "All glasses",
    "No glasses required",
    "Mentra Live",
    "even-g1",
  ])
    expect(html).toContain(`>${label}</option>`)
  expect(html).toContain("Showing 2 of 2 routines")
  expect(html.match(/<article /g)).toHaveLength(2)
  expect(html.match(/role="switch"/g)).toHaveLength(2)
  client.setQueryData(["routine-catalog"], {routines: []})
  const empty = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RoutineCatalogList />
    </QueryClientProvider>,
  )
  expect(empty).toContain("No routine has a published passing example")
  expect(empty).not.toContain("No routines match your filters")
})
test("catalog labels a historical example without claiming the current definition passed", () => {
  const markup = renderToStaticMarkup(
    <RoutineCatalogCard
      routine={{
        ...routine,
        example: {
          runId: "old-pass",
          startedAt: "2026-10-02T18:00:00Z",
          finishedAt: "2026-10-02T18:01:00Z",
          recordingAssetId: "video",
          definitionRevision: "a".repeat(40),
          build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
        },
      }}
    />,
  )
  expect(markup).toContain("Complete passing example available")
  expect(markup).toContain("earlier definition")
  expect(markup).toContain("aaaaaaaa")
  expect(markup).toContain("routine=notes-phone&amp;platform=ios-on-mac")
  expect(routineHref("notes-phone", "ios-on-mac")).toBe("/?routineCatalog=1&routine=notes-phone&platform=ios-on-mac")
})

test("catalog tile nightly switch defaults on, preserves the detail link and reports save failure", () => {
  const render = (nightlyEnabled?: boolean) =>
    renderToStaticMarkup(
      <RoutineCatalogCard
        routine={{...routine, example: null, nightlyEnabled}}
        preferenceError="Preference was not saved"
      />,
    )
  expect(render()).toContain('role="switch"')
  expect(render()).toContain('checked=""')
  expect(render(false)).not.toContain('checked=""')
  expect(render(false)).toContain("Runs nightly")
  expect(render(false)).toContain("Preference was not saved")
  expect(render(false)).toContain('href="/?routineCatalog=1&amp;routine=notes-phone&amp;platform=ios-on-mac"')
})

test("the existing run view shows a queued, rejected or cancelled request without invented execution evidence", () => {
  const request = {
    requestId: "stored-request",
    hostId: "mini",
    inputSha256: "d".repeat(64),
    routineId: "new-product",
    platform: "android",
    laneId: "phone",
    definitionRevision: "a".repeat(40),
    state: "queued",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    createdAt: "2026-10-03T11:00:00Z",
  }
  const render = (fields: Record<string, unknown> = {}) => {
    const client = new QueryClient()
    client.setQueryData(["framework-run", request.requestId], {kind: "request", request: {...request, ...fields}})
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FrameworkRunPage runId={request.requestId} />
      </QueryClientProvider>,
    )
  }
  const queued = render()
  expect(queued).toContain("new-product: queued")
  expect(queued).toContain("Requested build: dev")
  expect(queued).toContain("stored-request")
  expect(queued).toContain("Computer: mini · Lane: phone · android")
  expect(queued).toContain("This request refreshes automatically.")
  const rejected = render({
    state: "terminal",
    terminalStatus: "not-run",
    reason: "missing-definition: Exact source is not installed.",
  })
  expect(rejected).toContain("Did not run")
  expect(rejected).toContain("missing-definition: Exact source is not installed.")
  const cancelled = render({
    state: "terminal",
    terminalStatus: "cancelled",
    reason: "Nightly occurrence reached its completion boundary.",
  })
  expect(cancelled).toContain("new-product: cancelled")
  expect(cancelled).toContain("Nightly occurrence reached its completion boundary.")
  expect(cancelled).toContain("Checking for final host custody or a published result for ten minutes.")
  expect(cancelled).toContain("Refresh request")
  const acknowledged = render({
    state: "terminal",
    terminalStatus: "cancelled",
    cancellationRequested: true,
    cancellationAcknowledged: true,
    acceptedAt: "2026-10-03T11:01:00Z",
  })
  expect(acknowledged).toContain("Host accepted")
  expect(acknowledged).toContain("Host acknowledged; cleanup may still be running.")
  for (const html of [queued, rejected, cancelled]) {
    expect(html).toContain("No routine result has been published.")
    expect(html).not.toContain("Tested build")
    expect(html).not.toContain("<video")
    expect(html).not.toContain("Execution steps")
    expect(html).not.toContain("Setup details")
  }
})

test("cancelled receipts reconcile within a bounded view window without treating host acknowledgement as a result", () => {
  const request = {
    requestId: "cancelled-request",
    hostId: "mini",
    inputSha256: "d".repeat(64),
    routineId: "new-product",
    platform: "android" as const,
    laneId: "phone",
    definitionRevision: "a".repeat(40),
    state: "terminal" as const,
    terminalStatus: "cancelled",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev" as const, headSha: "b".repeat(40)},
    cancellationRequested: true,
  }
  const observedAt = Date.parse("2026-10-03T11:00:00Z")
  const receipt = {kind: "request" as const, request}
  expect(frameworkRunRefetchInterval(receipt, observedAt, observedAt)).toBe(5000)
  expect(
    frameworkRunRefetchInterval(
      {...receipt, request: {...request, cancellationAcknowledged: true, acceptedAt: "2026-10-03T11:01:00Z"}},
      observedAt,
      observedAt + 599999,
    ),
  ).toBe(5000)
  expect(frameworkRunRefetchInterval(receipt, observedAt, observedAt + 600000)).toBe(false)
  expect(frameworkRunRefetchInterval(receipt, observedAt + 600000, observedAt + 600000)).toBe(5000)
  expect(
    frameworkRunRefetchInterval({...receipt, request: {...request, terminalStatus: "not-run"}}, observedAt, observedAt),
  ).toBe(false)
  expect(
    frameworkRunRefetchInterval({...receipt, request: {...request, state: "queued"}}, observedAt, observedAt + 600000),
  ).toBe(5000)
})

test("run keeps steps and recording in one equal-height desktop row with evidence below", () => {
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource("c".repeat(40)),
    frameworkBinding: testFrameworkBinding(),
    requestId: "request",
    hostId: "mini",
    routineId: "notes-phone",
    definitionRevision: "c".repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:02:00Z",
    recordingAssetId: "recording",
    assets: [
      {id: "recording", kind: "recording", path: "video.mp4", sha256: "a".repeat(64), size: 100, mimeType: "video/mp4"},
    ],
    result: {
      runId: "request",
      finishedAt: "2026-10-03T19:02:00Z",
      setup: {status: "passed"},
      test: "passed",
      steps: Array.from({length: 71}, (_, index) => ({
        id: `step-${index}`,
        status: "passed",
        durationMs: 1000,
        recordingLocation: {assetId: "recording", startOffsetMs: index * 1000},
      })),
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [],
      evidence: ["recording"],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 1000, testMs: 71000, teardownMs: 1000},
    },
  })
  const client = new QueryClient()
  const render = (uploadsComplete: boolean, stepId?: string) => {
    client.setQueryData(["framework-run", "saved-run"], {
      run,
      definition: null,
      outcome: "pass",
      uploadsComplete,
      evidenceStatus: "complete",
    })
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FrameworkRunPage runId="saved-run" stepId={stepId} />
      </QueryClientProvider>,
    )
  }
  const html = render(true)
  expect(html).toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]")
  expect(html.indexOf('aria-label="Run recording"')).toBeLessThan(html.indexOf('aria-label="Execution steps"'))
  expect(html).toContain("order-2 lg:order-1 lg:flex lg:min-h-0 lg:flex-col")
  expect(html).toContain("lg:h-[calc(var(--recording-height)+5rem)]")
  expect(html).toContain('role="region" aria-label="Execution details" tabindex="0"')
  expect(html).toContain("lg:overflow-y-auto")
  expect(html).not.toContain("lg:sticky")
  expect(html).toContain("h-[var(--recording-height)]")
  expect(html).toContain("object-contain")
  expect(html.indexOf('aria-label="Setup details"')).toBeLessThan(html.indexOf('aria-label="Run recording"'))
  expect(html.indexOf('aria-label="Teardown details"')).toBeGreaterThan(html.indexOf('aria-label="Execution steps"'))
  expect(html.indexOf('aria-label="Teardown details"')).toBeLessThan(
    html.indexOf('<h3 class="font-semibold">Evidence</h3>'),
  )
  expect(html).toContain("Setup action details were not recorded for this run.")
  expect(html).toContain("Teardown action details were not recorded for this run.")
  expect(html.match(/Watch this step/g)).toHaveLength(71)
  expect(html).toContain("Search steps")
  expect(html).toContain("Watch this step · 01:10")
  const selected = render(true, "step-60")
  expect(selected).toContain('aria-current="step"')
  expect(selected).toContain("border-[#3b7650] bg-[#edf6ef]")
  expect(html).toContain("Tested build: dev")
  expect(html).toContain("https://github.com/Mentra-Community/MentraOS/commit/" + "b".repeat(40))
  expect(html.match(/class="w-7 shrink-0 text-right"/g)).toHaveLength(71)
  expect(html).toContain('class="w-7 shrink-0 text-right">71.</span>')
  expect(html).toContain("Started ")
  expect(html).toContain("Setup 1s · Test 1m 11s · Teardown 1s")
  expect(html).toContain("/api/admin/routine-catalog/results/by-run/saved-run/assets/recording")
  const pending = render(false)
  expect(pending).toContain("Evidence upload pending")
  expect(pending).not.toContain("<video")
  expect(pending).not.toContain("lg:overflow-y-auto")
  for (const status of ["failed", "cancelled"] as const) {
    client.setQueryData(["framework-run", "saved-run"], {
      run: {...run, result: {...run.result, setup: {status, actionId: "legacy-entry"}}},
      definition: null,
      outcome: status,
      uploadsComplete: false,
      evidenceStatus: "complete",
    })
    const legacy = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FrameworkRunPage runId="saved-run" />
      </QueryClientProvider>,
    )
    expect(legacy).toContain("Stopped at: legacy-entry")
    expect(legacy).toContain("Setup action details were not recorded")
    expect(legacy).toContain(status === "cancelled" ? "Cancelled" : "failed")
  }
})

test("routine lifecycle rows report real actions without video and keep failures in their phase", () => {
  const run = frameworkRunSchema.parse({
    schemaVersion: 1,
    routineSource: testRoutineSource("c".repeat(40)),
    frameworkBinding: testFrameworkBinding(),
    requestId: "lifecycle-request",
    hostId: "mini",
    routineId: "notes-phone",
    definitionRevision: "c".repeat(40),
    platform: "ios-on-mac",
    laneId: "mac",
    build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)},
    startedAt: "2026-10-03T19:00:00Z",
    finishedAt: "2026-10-03T19:02:00Z",
    recordingAssetId: "recording",
    assets: [
      {id: "recording", kind: "recording", path: "video.mp4", sha256: "a".repeat(64), size: 100, mimeType: "video/mp4"},
    ],
    result: {
      runId: "lifecycle-request",
      finishedAt: "2026-10-03T19:02:00Z",
      setup: {
        status: "passed",
        actions: [
          {
            id: "install",
            stage: "before-entry",
            instruction: "Install the selected Mentra App",
            expected: "Requested build installed",
            scope: "shared",
            status: "passed",
            durationMs: 1000,
          },
          {
            id: "prepare-note",
            stage: "after-entry",
            instruction: "Prepare a note fixture",
            fixtureProvider: "notes-data",
            expected: "Fixture available",
            scope: "routine",
            status: "passed",
            durationMs: 1500,
            startedAt: "2026-10-03T19:00:01Z",
            finishedAt: "2026-10-03T19:00:02.500Z",
          },
        ],
      },
      test: "passed",
      steps: [
        {id: "create", status: "passed", durationMs: 1000, recordingLocation: {assetId: "recording", startOffsetMs: 0}},
      ],
      teardown: {
        ready: false,
        outcomes: [],
        errors: [],
        unavailableResources: [],
        actions: [
          {
            id: "delete-note",
            stage: "resource-cleanup",
            instruction: "Remove the note fixture",
            fixtureProvider: "notes-data",
            expected: "Fixture absent",
            scope: "routine",
            status: "failed",
            durationMs: 2500,
          },
          {
            id: "stop-audio",
            stage: "resource-cleanup",
            instruction: "Stop fixture audio",
            expected: "Audio stopped",
            scope: "routine",
            status: "not-run",
            durationMs: 0,
            causedBy: "lost-ownership",
          },
          {
            id: "uninstall",
            stage: "resource-cleanup",
            instruction: "Uninstall the Mentra App",
            expected: "Test app absent",
            scope: "shared",
            status: "passed",
            durationMs: 800,
          },
        ],
      },
      failures: [
        {phase: "teardown", actionId: "delete-note", message: "Fixture removal failed"},
        {phase: "evidence", actionId: "upload-log", message: "Log upload unavailable"},
      ],
      evidence: ["recording"],
      timing: {startedAt: "2026-10-03T19:00:00Z", setupMs: 2500, testMs: 1000, teardownMs: 3300},
    },
  })
  const client = new QueryClient()
  client.setQueryData(["framework-run", "lifecycle-run"], {
    run,
    definition: routine.definition,
    outcome: "teardown-failed",
    uploadsComplete: true,
    evidenceStatus: "failed",
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FrameworkRunPage runId="lifecycle-run" />
    </QueryClientProvider>,
  )
  const setup = html.slice(html.indexOf('aria-label="Setup details"'), html.indexOf('aria-label="Run recording"'))
  const teardown = html.slice(
    html.indexOf('aria-label="Teardown details"'),
    html.indexOf('<h3 class="font-semibold">Evidence</h3>'),
  )
  expect(setup).toContain("Prepare a note fixture")
  expect(teardown).toContain("Remove the note fixture")
  expect(setup).toContain('aria-label="Setup: Before entry"')
  expect(setup).toContain('aria-label="Setup: After entry"')
  expect(teardown.match(/aria-label="Teardown: Resource cleanup"/g)).toHaveLength(1)
  expect(teardown.indexOf("Remove the note fixture")).toBeLessThan(teardown.indexOf("Uninstall the Mentra App"))
  expect(setup).toContain("2s")
  expect(setup).toContain("Started ")
  expect(setup).toContain("<details")
  expect(setup).not.toContain('open=""')
  expect(teardown).toContain('open=""')
  expect(setup).toContain("Framework</span>")
  expect(setup).toContain("Routine</span>")
  expect(setup.indexOf("Install the selected Mentra App")).toBeLessThan(setup.indexOf("Prepare a note fixture"))
  expect(teardown).toContain("Remove the note fixture")
  expect(teardown).toContain("3s")
  expect(teardown).toContain("Not run")
  expect(teardown).not.toContain("0s")
  expect(teardown).toContain("lost-ownership")
  expect(teardown).toContain("Fixture removal failed")
  for (const phase of [setup, teardown]) {
    expect(phase).not.toContain("<video")
    expect(phase).not.toContain("Watch this step")
  }
  expect(teardown).not.toContain("Log upload unavailable")
  expect(html.slice(html.indexOf('<h3 class="font-semibold">Evidence</h3>'))).toContain("Log upload unavailable")
  // Expand stages up to the last failure, independently for setup and teardown.
  for (const phase of ["setup", "teardown"] as const) for (const failed of [[], [3], [0, 4]]) {
    const candidate = structuredClone(run);
    const stages = phase === "setup" ? ["before-entry", "entry", "after-entry"] as const
      : ["recording", "teardown-actions", "resource-cleanup"] as const;
    candidate.result[phase].actions = stages.flatMap((stage, group) => [0, 1].map(offset => {
      const index = group * 2 + offset;
      return {id: `action-${index}`, instruction: `Chronological action ${index}`, expected: "Ready", stage,
        scope: offset ? "routine" as const : "shared" as const,
        status: failed.includes(index) ? "failed" as const : "passed" as const, durationMs: 100};
    }));
    candidate.result.failures = [];
    candidate.result.setup.status = phase === "setup" && failed.length ? "failed" : "passed";
    candidate.result.teardown.ready = phase !== "teardown" || !failed.length;
    client.setQueryData(["framework-run", "lifecycle-run"], {run: candidate, definition: routine.definition,
      outcome: failed.length ? `${phase}-failed` : "pass", uploadsComplete: true, evidenceStatus: "complete"});
    const rendered = renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunPage runId="lifecycle-run" /></QueryClientProvider>);
    const title = phase === "setup" ? "Setup" : "Teardown";
    const sections = [...rendered.matchAll(/<details\b([^>]*)>/g)].filter(match => match[1]!.includes(`aria-label="${title}:`));
    expect(sections).toHaveLength(3);
    expect(sections.map(match => match[1]!.includes('open=""'))).toEqual(stages.map((_, index) => failed.length > 0 && index <= Math.floor(Math.max(...failed) / 2)));
    for (let index = 1; index < 6; index++) expect(rendered.indexOf(`Chronological action ${index - 1}`)).toBeLessThan(rendered.indexOf(`Chronological action ${index}`));
  }
  run.result.setup.actions = []
  run.result.teardown.actions = []
  client.setQueryData(["framework-run", "lifecycle-run"], {
    run: {...run},
    definition: routine.definition,
    outcome: "teardown-failed",
    uploadsComplete: true,
    evidenceStatus: "failed",
  })
  const empty = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FrameworkRunPage runId="lifecycle-run" />
    </QueryClientProvider>,
  )
  expect(empty).toContain("No setup actions recorded.")
  expect(empty).toContain("No teardown actions recorded.")
})

test("catalog run links use the result route understood by the Admin shell", () => {
  const href = frameworkRunHref("old-pass")
  expect(href).toBe("/?testRun=old-pass")
  expect(readTestRunLink(new URL(href, "https://admin.mentraglass.com").search)).toEqual({runID: "old-pass"})
  const html = renderToStaticMarkup(
    <RoutineCatalogCard
      routine={{
        ...routine,
        example: null,
        latestAttempt: {
          runId: "old-pass",
          startedAt: "2026-10-02T18:00:00Z",
          outcome: "pass",
          uploadsComplete: true,
          evidenceStatus: "complete",
          definitionRevision: "c".repeat(40),
        },
      }}
    />,
  )
  expect(html).toContain('href="/?testRun=old-pass"')
})

test("step search matches recorded identity and English definition text without changing recording offsets", () => {
  const step = {
    id: "create",
    status: "passed" as const,
    durationMs: 1000,
    recordingLocation: {assetId: "video", startOffsetMs: 123456},
  }
  expect(matchesStepSearch(step, routine.definition.steps[0], "  NOTE SAVED ")).toBe(true)
  expect(matchesStepSearch(step, routine.definition.steps[0], "create")).toBe(true)
  expect(matchesStepSearch(step, undefined, "create")).toBe(true)
  expect(matchesStepSearch(step, routine.definition.steps[0], "login")).toBe(false)
  expect(recordingOffset(step.recordingLocation.startOffsetMs)).toBe("02:03")
  expect(recordingOffset(59999)).toBe("00:59")
})

const historyRun: Extract<TestHistoryEntry, {kind: "run"}> = {
  kind: "run" as const,
  routineSource: testRoutineSource("c".repeat(40)),
  frameworkBinding: testFrameworkBinding(),
  runId: "standalone-run",
  requestId: "standalone-request",
  hostId: "mini",
  routineId: "no-glasses",
  platform: "ios-on-mac",
  laneId: "mac",
  startedAt: "2026-10-03T19:00:00Z",
  finishedAt: "2026-10-03T19:01:00Z",
  outcome: "pass",
  evidenceStatus: "complete",
  uploadsComplete: true,
  build: {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40), release: "dev.577"},
}
test("history requests hide reruns by default and preserve exact cursor when enabled", () => {
  expect(testHistoryListPath(false)).toBe("/api/admin/test-runs/history/list?limit=25&includeReruns=false");
  expect(testHistoryListPath(true, "cursor/+next")).toBe("/api/admin/test-runs/history/list?limit=25&includeReruns=true&cursor=cursor%2F%2Bnext");
  const client = new QueryClient();
  client.setQueryData(["test-history", false], {pages: [{entries: [historyRun], nextCursor: null}], pageParams: [undefined]});
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunsPage/></QueryClientProvider>);
  expect(html).toContain('role="switch" aria-checked="false"');
  expect(html).toContain("Show reruns");
  client.clear();
});
test("history matches a single suite member against all filters and treats missing metadata as unknown", () => {
  const camera = {
    ...routine,
    routineId: "camera",
    platform: "android" as const,
    definition: {
      ...routine.definition,
      title: "Camera settings",
      purpose: "Verify photo sizes",
      glasses: {models: ["mentra-live"]},
    },
  }
  const suite: TestHistoryEntry = {
    kind: "suite",
    suiteId: "nightly",
    rerunCount: 0,
    failedCount: 0,
    lanes: [],
    channel: "dev",
    trigger: "nightly",
    startedAt: historyRun.startedAt,
    outcome: "passed",
    expectedCount: 2,
    passed: 2,
    build: historyRun.build,
    members: [
      {routineId: routine.routineId, platform: routine.platform},
      {routineId: camera.routineId, platform: camera.platform},
    ],
  }
  const filters = {search: " PHOTO ", platform: "android", glasses: "mentra-live"}
  expect(matchesHistorySearch(suite, [routine, camera], filters)).toBe(true)
  expect(matchesHistorySearch(suite, [routine, camera], {...filters, search: "note"})).toBe(false)
  expect(
    matchesHistorySearch(suite, [routine, camera], {search: "note", platform: "ios-on-mac", glasses: "no-glasses"}),
  ).toBe(true)
  expect(matchesHistorySearch({...historyRun, routineId: "camera", platform: "android"}, [camera], filters)).toBe(true)
  expect(matchesHistorySearch(historyRun, [], {search: "no-glass", platform: "ios-on-mac", glasses: ""})).toBe(true)
  expect(matchesHistorySearch(historyRun, [], {...EMPTY_ROUTINE_FILTERS, glasses: "no-glasses"})).toBe(false)
  expect(matchesHistorySearch({...suite, members: undefined}, [routine], filters)).toBe(false)
  const unavailable: TestHistoryEntry = {
    kind: "unavailable",
    sourceKind: "run",
    id: "missing",
    startedAt: historyRun.startedAt,
    message: "Details unavailable.",
  }
  expect(matchesHistorySearch(unavailable, [], EMPTY_ROUTINE_FILTERS)).toBe(true)
  expect(matchesHistorySearch(unavailable, [], filters)).toBe(false)
})

test("shared filters preserve selected options through refresh and expose clearing", () => {
  const html = renderToStaticMarkup(
    <RoutineSearch
      filters={{search: "photo", platform: "android", glasses: "mentra-live"}}
      onChange={() => {}}
      routines={[]}
      countLabel="Showing 0 of 3 loaded entries"
    />,
  )
  expect(html).toContain('value="android" selected=""')
  expect(html).toContain('value="mentra-live" selected=""')
  expect(html).toContain("Clear filters")
  expect(html).toContain("Showing 0 of 3 loaded entries")
})

test("combined history renders chronological suites and standalone runs across loaded pages", () => {
  const client = new QueryClient()
  client.setQueryData(["test-history", false], {
    pages: [
      {
        entries: [
          {
            kind: "suite",
            suiteId: "nightly-two",
            channel: "dev",
            trigger: "nightly",
            startedAt: "2026-10-03T20:00:00Z",
            outcome: "running",
            expectedCount: 2,
            passed: 1,
            build: {headSha: "a".repeat(40)},
          },
        ],
        nextCursor: "next",
      },
      {entries: [historyRun], nextCursor: "older"},
    ],
    pageParams: [undefined, "next"],
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FrameworkRunsPage />
    </QueryClientProvider>,
  )
  expect(html).toContain('href="/?testSuite=nightly-two"')
  expect(html).toContain('href="/?testRun=standalone-run"')
  expect(html.indexOf("nightly-two")).toBeLessThan(html.indexOf("standalone-run"))
  expect(html).toContain("1/2 passed")
  expect(html).toContain("dev.577")
  expect(html).toContain("More history")
  expect(html).toContain('role="search" aria-label="Search routines"')
  expect(html).toContain("Showing 2 of 2 loaded entries")
  expect(html).toContain("Load more history to search older entries")
  expect(html.match(/standalone-run/g)).toHaveLength(1)
})
test("history and scoped lists show passed totals and skipped counts", () => {
  const client = new QueryClient()
  const counted = {...historyRun, stepCounts: {passed: 2, total: 5, skipped: 1}}
  client.setQueryData(["test-history", false], {
    pages: [
      {
        entries: [
          counted,
          {
            kind: "suite",
            suiteId: "skipped-suite",
            channel: "dev",
            trigger: "nightly",
            startedAt: historyRun.startedAt,
            outcome: "failed",
            expectedCount: 3,
            passed: 1,
            skipped: 2,
            build: historyRun.build,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  })
  const render = (scope?: Record<string, string>) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FrameworkRunsPage scope={scope} />
      </QueryClientProvider>,
    )
  expect(render()).toContain("2/5 passed, 1 skipped")
  expect(render()).toContain("1/3 passed with complete evidence, 2 skipped")
  const scope = {channel: "dev", headSha: "b".repeat(40)}
  client.setQueryData(["framework-runs", new URLSearchParams(scope).toString()], {
    pages: [{runs: [counted], nextCursor: null}],
    pageParams: [undefined],
  })
  expect(render(scope)).toContain("2/5 passed, 1 skipped")
  client.clear()
})
test("history distinguishes empty data and cached refresh failures while keeping filtered build links scoped", () => {
  const client = new QueryClient()
  const render = (scope?: Record<string, string>) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FrameworkRunsPage scope={scope} />
      </QueryClientProvider>,
    )
  client.setQueryData(["test-history", false], {pages: [{entries: [], nextCursor: null}], pageParams: [undefined]})
  expect(render()).toContain("No test suites or routine runs yet")
  client.setQueryData(["test-history", false], {pages: [{entries: [historyRun], nextCursor: null}], pageParams: [undefined]})
  client
    .getQueryCache()
    .find({queryKey: ["test-history", false]})!
    .setState({error: new Error("refresh refused"), status: "error"})
  expect(render()).toContain("History could not refresh: refresh refused")
  expect(render()).toContain("standalone-run")
  const scope = {channel: "dev", headSha: "b".repeat(40), routineId: "no-glasses"}
  client.setQueryData(["framework-runs", new URLSearchParams(scope).toString()], {
    pages: [{runs: [historyRun], nextCursor: null}],
    pageParams: [undefined],
  })
  const scoped = render(scope)
  expect(scoped).toContain("Filtered routine runs")
  expect(scoped).not.toContain("nightly-two")
  expect(scoped).toContain("dev.577")
  client.setQueryData(["framework-runs", new URLSearchParams(scope).toString()], {
    pages: [{runs: [historyRun], nextCursor: "older"}],
    pageParams: [undefined],
  })
  expect(render(scope)).toContain("More runs")
  expect(render(scope)).toContain("Showing 1 of 1 loaded runs")
  client.setQueryData(["framework-runs", new URLSearchParams(scope).toString()], {
    pages: [
      {runs: [historyRun], nextCursor: "older"},
      {runs: [{...historyRun, runId: "older-result", requestId: "older-request"}], nextCursor: null},
    ],
    pageParams: [undefined, "older"],
  })
  expect(render(scope)).toContain("older-result")
  expect(render(scope)).toContain("Showing 2 of 2 loaded runs")
  expect(render(scope)).not.toContain("More runs")
})

test("initial history failure offers retry instead of claiming empty history", () => {
  const client = new QueryClient()
  client
    .getQueryCache()
    .build(client, {queryKey: ["test-history", false]})
    .setState({error: new Error("Request timed out. Please try again."), status: "error", fetchStatus: "idle"})
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FrameworkRunsPage />
    </QueryClientProvider>,
  )
  expect(html).toContain("Could not load test history: Request timed out. Please try again.")
  expect(html).toContain(">Retry</button>")
  expect(html).not.toContain("Loading test history")
  expect(html).not.toContain("No test suites or routine runs yet")
  expect(html).toContain('role="switch" aria-checked="false"')
  expect(html).toContain("Show reruns")
})

test("history visibility control stays available while the selected query is loading", () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunsPage/></QueryClientProvider>);
  expect(html).toContain("Loading test history");
  expect(html).toContain('role="switch" aria-checked="false"');
  expect(html).toContain("Show reruns");
  expect(html).not.toContain("No test suites or routine runs yet");
  client.clear();
});

test("unavailable history details retain their links without hiding neighboring results", () => {
  const client = new QueryClient()
  client.setQueryData(["test-history", false], {
    pages: [
      {
        entries: [
          historyRun,
          {
            kind: "unavailable",
            sourceKind: "run",
            id: "unreadable-run",
            startedAt: "2026-10-03T18:00:00Z",
            message: "Details unavailable.",
          },
          {
            kind: "unavailable",
            sourceKind: "suite",
            id: "unreadable-suite",
            startedAt: "2026-10-03T17:00:00Z",
            message: "Details unavailable.",
          },
          {
            kind: "suite",
            suiteId: "older-suite",
            channel: "dev",
            trigger: "nightly",
            startedAt: "2026-10-03T16:00:00Z",
            outcome: "passed",
            expectedCount: 2,
            passed: 2,
            build: {headSha: "a".repeat(40)},
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <FrameworkRunsPage />
    </QueryClientProvider>,
  )
  expect(html).toContain('href="/?testRun=unreadable-run"')
  expect(html).toContain('href="/?testSuite=unreadable-suite"')
  expect(html).toContain('href="/?testRun=standalone-run"')
  expect(html).toContain('href="/?testSuite=older-suite"')
  expect(html.match(/Details unavailable\./g)).toHaveLength(2)
  expect(html).toContain("2/2 passed with complete evidence")
  expect(html.indexOf("standalone-run")).toBeLessThan(html.indexOf("unreadable-run"))
  expect(html.indexOf("unreadable-suite")).toBeLessThan(html.indexOf("older-suite"))
})


test('preparing request detail explains exact source custody without calling it historical', () => {
  const client=new QueryClient();
  client.setQueryData(['framework-run','preparing-source'],{kind:'request',request:{requestId:'preparing-source',hostId:'mini',dispatchIntentSha256:'d'.repeat(64),routineId:'new-main',definitionRevision:'a'.repeat(40),platform:'android',laneId:'phone',state:'preparing',reason:'Waiting for installed routine API.',build:{repository:'Mentra-Community/MentraOS',channel:'dev',headSha:'b'.repeat(40)}}});
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><FrameworkRunPage runId='preparing-source'/></QueryClientProvider>);
  expect(html).toContain('new-main: preparing');expect(html).toContain('The exact routine source is being prepared');expect(html).toContain('Waiting for installed routine API.');expect(html).not.toContain('this historical request');
});
