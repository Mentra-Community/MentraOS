import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {FrameworkHealth, LaneHealthHost, LaneHealthSection, laneOverviewQuery} from "./lane-health"
import {SystemHealthPage} from "./system-health";
import type {LaneRepairStatus, LaneRestorationHost} from "../../../../packages/core/src/types/lane-restoration.types";

const now = Date.parse("2026-10-06T03:00:00Z"), at = new Date(now).toISOString();
const host: LaneRestorationHost = {hostId: "mini-controller", observedAt: at, receivedAt: at, restoration: null,
  lanes: [{id: "mini-mac", platform: "ios-on-mac", state: "idle", dispatchMode: "automatic"},
    {id: "mini-android", platform: "android", state: "reserved", dispatchMode: "paused"}]};

test("main System Health shows controller lanes independently of host monitoring", () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  client.setQueryData(["test-host-health"], {hosts: []});
  const current = new Date().toISOString();
  client.setQueryData(["lane-overview"], {hosts: [{...host, observedAt: current, receivedAt: current}], freshForMs: 120_000});
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SystemHealthPage />
    </QueryClientProvider>,
  )
  expect(html).toContain("Device lanes");
  expect(html).toContain("mini-mac");
  expect(html).toContain("mini-android");
  expect(html).toContain("Idle");
  expect(html).toContain("Reserved");
  expect(html).toContain("Paused");
  expect(html).toContain("No independent host monitor");
  expect(html).toContain("Controller reporting");
  expect(html).toContain("hostId=mini-controller&amp;laneId=mini-mac");
  client.clear();
})
test("framework health distinguishes current accepted source, API, pending target and stopped or stale history", () => {
  const binding = {
    version: 450,
    revision: "a".repeat(40),
    installationId: "release-450",
    configurationSha256: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
    routineApiVersion: 7,
    publicApiSha256: "d".repeat(64),
  }
  const current = {
    ...host,
    frameworkBinding: binding,
    frameworkAcceptedAt: at,
    frameworkHistory: [
      {
        binding,
        incarnation: "boot",
        incarnationGeneration: 1,
        process: {pid: 42, startedAt: "first"},
        effectiveAt: at,
        observedAt: at,
      },
    ],
    deployment: {
      phase: "waiting" as const,
      observedAt: at,
      desiredTarget: {...binding, version: 452, installationId: "release-452", revision: "e".repeat(40)},
      activeTarget: {...binding, version: 451, installationId: "release-451", revision: "f".repeat(40)},
      consumers: [{id: "executor", kind: "executor", reason: "Allocated test is still active"}],
      nextAction: "Wait for safe boundary",
    },
  }
  const html = renderToStaticMarkup(<FrameworkHealth host={current} fresh />)
  expect(html).toContain("Running framework")
  expect(html).toContain("Version 450 · Routine API 7")
  expect(html).toContain("Version 452 · Routine API 7")
  expect(html).toContain("Activating version 451")
  expect(html).toContain("Allocated test is still active")
  expect(html).toContain("End not observed")
  for (const changed of [
    {fresh: false, host: current},
    {
      fresh: true,
      host: {
        ...current,
        frameworkHistory: [{...current.frameworkHistory[0], endedAt: at, endReason: "observed-stop" as const}],
      },
    },
    {fresh: true, host: {...current, frameworkBinding: undefined}},
  ]) {
    const stale = renderToStaticMarkup(<FrameworkHealth {...changed} />)
    expect(stale).not.toContain("Running framework")
    expect(stale).toContain("Last confirmed framework")
    expect(stale).toContain("Version 450")
  }
  expect(renderToStaticMarkup(<FrameworkHealth host={host} fresh />)).not.toContain("Running framework")
})

test("stale observation, stale receipt and refresh failures never show current lane status", () => {
  for (const fields of [{observedAt: new Date(now - 120_001).toISOString()}, {receivedAt: new Date(now - 120_001).toISOString()}, {}]) {
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    client.setQueryData(["lane-overview"], {hosts: [{...host, ...fields}], freshForMs: 120_000});
    if (!Object.keys(fields).length) client.getQueryCache().find({queryKey: ["lane-overview"]})!.setState({status: "error", error: new Error("Refresh failed")});
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LaneHealthSection now={now} />
      </QueryClientProvider>,
    )
    expect(html).toContain("Current lane status is unknown");
    expect(html).toContain("Last reported state: Idle");
    expect(html).not.toContain(">Controller reporting");
    expect(html).not.toContain('text-[#087d50]">Idle');
    client.clear();
  }
})

test("repair and offline states remain explicit; unknown states do not become idle", () => {
  const lanes = ["in-repair", "out-of-service", "offline", "new-state"].map(state => ({...host.lanes[0], id: state, state}));
  const html = renderToStaticMarkup(<LaneHealthHost host={{...host, lanes}} fresh />);
  for (const text of ["In repair", "Out of service", "Offline", "Unknown"]) expect(html).toContain(text);
  expect(html).not.toContain(">Idle<");
});

test('overview uses one lightweight query and the last interval keeps observed stops truthful', async () => {
  const original = globalThis.fetch; let url = '';
  globalThis.fetch = (async input => {url = String(input); return Response.json({hosts: [], freshForMs: 120000});}) as typeof fetch;
  try {await laneOverviewQuery.queryFn(); expect(url).toBe('/api/admin/test-runs/lanes/overview')}
  finally {globalThis.fetch = original}
  const binding = {version: 1, revision: 'a'.repeat(40), installationId: 'one', configurationSha256: 'b'.repeat(64),
    runtimeSha256: 'c'.repeat(64), routineApiVersion: 14, publicApiSha256: 'd'.repeat(64)};
  const {restoration: _restoration, ...current} = host;
  const html = renderToStaticMarkup(<FrameworkHealth host={{...current, frameworkBinding: binding, frameworkAcceptedAt: at,
    frameworkCurrentInterval: {binding, incarnation: 'boot', incarnationGeneration: 1, process: {pid: 42, startedAt: 'one'},
      effectiveAt: at, observedAt: at, endedAt: at, endReason: 'observed-stop'}}} fresh />);
  expect(html).toContain('Controller stop was observed'); expect(html).not.toContain('Running framework');
  expect(html).not.toContain('Installation history');
});

test('all five dynamically reported lanes show readable labels, exact IDs and current owner links', () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}})
  const hosts = ['computer-1', 'computer-2', 'computer-3'].map((hostId, index) => ({...host, hostId,
    lanes: (index === 2 ? ['android'] : ['ios-on-mac', 'android']).map((platform, laneIndex) => ({
      id: `new-lane-${index}-${laneIndex}`, platform: platform as 'android' | 'ios-on-mac',
      state: laneIndex === 0 ? 'running' : 'reserved', dispatchMode: laneIndex === 0 ? 'automatic' : 'paused',
      glassesModels: ['mentra-live'], activity: {generation: index + 1, owner: laneIndex === 0
        ? {id: `request:${index}`, kind: 'run' as const, requestId: `request:${index}`}
        : {id: `reservation:${index}`, kind: 'authoring' as const}},
    }))}))
  client.setQueryData(['lane-overview'], {hosts, freshForMs: 120_000})
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><LaneHealthSection now={now} /></QueryClientProvider>)
  expect((html.match(/Lane: /g) ?? []).length).toBe(5)
  for (const row of hosts) for (const lane of row.lanes) {
    expect(html).toContain(lane.id)
    expect(html).toContain(`hostId=${row.hostId}&amp;laneId=${lane.id}`)
  }
  expect(html).toContain('Computer 1 · iOS on Mac · Mentra Live')
  expect(html).toContain('Computer 3 · Android · Mentra Live')
  expect(html).toContain('Routine run')
  expect(html).toContain('Authoring reservation')
  expect(html).toContain('/?testRun=request%3A0')
  expect(html).not.toContain('/?testRun=reservation')
  expect(html).toContain('Paused')
  client.clear()
})

test('stale owner context is explicitly historical and cannot link to a current run', () => {
  const reported = {...host, lanes: [{...host.lanes[0], state: 'running', glassesModels: [],
    activity: {generation: 4, owner: {id: 'request:old', kind: 'run' as const, requestId: 'request:old'}}}]}
  const html = renderToStaticMarkup(<LaneHealthHost host={reported} fresh={false} />)
  expect(html).toContain('Last reported owner')
  expect(html).toContain('request:old')
  expect(html).toContain('Current lane status is unknown')
  expect(html).not.toContain('/?testRun=')
  expect(html).toContain('No glasses')
})

const repair: LaneRepairStatus = {executionId: 'fixer:actual', interruptionId: 'repair:mac:79', laneId: 'mini-mac',
  state: 'working', current: true, startedAt: at, finishedAt: null};
const repairHost = {...host, lanes: [{...host.lanes[0], state: 'out-of-service',
  activity: {generation: 80, owner: {id: repair.executionId, kind: 'fixer' as const}}, repair}]};

test('halted repair custody is explicit and never implies that an agent is running', () => {
  const html = renderToStaticMarkup(<LaneHealthHost host={{...repairHost, lanes: [{...repairHost.lanes[0],
    repair: {...repair, state: 'halted', current: false, finishedAt: at}}]}} fresh />);
  for (const text of ['Out of service', 'Repair custody', 'Repair halted', 'Generation 80', repair.executionId])
    expect(html).toContain(text);
  expect(html).not.toContain('Repair running');
  expect(html).not.toContain('State repair');
});

test('repair running requires the exact active invocation and a fresh controller observation', () => {
  expect(renderToStaticMarkup(<LaneHealthHost host={repairHost} fresh />)).toContain('Repair running');
  for (const changed of [undefined, {...repair, startedAt: null}, {...repair, finishedAt: at}, {...repair, current: false},
    {...repair, executionId: 'fixer:foreign'}, {...repair, laneId: 'another-lane'}]) {
    const html = renderToStaticMarkup(<LaneHealthHost host={{...repairHost, lanes: [{...repairHost.lanes[0], repair: changed}]}} fresh />);
    expect(html).toContain('Repair execution unknown');
    expect(html).not.toContain('Repair running');
  }
  const stale = renderToStaticMarkup(<LaneHealthHost host={repairHost} fresh={false} />);
  expect(stale).toContain('Last reported owner');
  expect(stale).toContain('Repair execution unknown');
  expect(stale).not.toContain('Repair running');
});
