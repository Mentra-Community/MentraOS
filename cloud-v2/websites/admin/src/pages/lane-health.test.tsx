import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {FrameworkHealth, LaneHealthHost, LaneHealthSection} from "./lane-health"
import {SystemHealthPage} from "./system-health";
import type {LaneRestorationHost} from "../../../../packages/core/src/types/lane-restoration.types";

const now = Date.parse("2026-10-06T03:00:00Z"), at = new Date(now).toISOString();
const host: LaneRestorationHost = {hostId: "mini-controller", observedAt: at, receivedAt: at, restoration: null,
  lanes: [{id: "mini-mac", platform: "ios-on-mac", state: "idle", dispatchMode: "automatic"},
    {id: "mini-android", platform: "android", state: "reserved", dispatchMode: "paused"}]};

test("main System Health shows controller lanes independently of host monitoring", () => {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  client.setQueryData(["test-host-health"], {hosts: []});
  const current = new Date().toISOString();
  client.setQueryData(["lane-restoration"], {hosts: [{...host, observedAt: current, receivedAt: current}], freshForMs: 120_000});
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
    client.setQueryData(["lane-restoration"], {hosts: [{...host, ...fields}], freshForMs: 120_000});
    if (!Object.keys(fields).length) client.getQueryCache().find({queryKey: ["lane-restoration"]})!.setState({status: "error", error: new Error("Refresh failed")});
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
