import {useEffect, useRef, useState} from "react";
import {useInfiniteQuery, useQuery} from "@tanstack/react-query";
import type {CatalogExample, CatalogHistoryRun, FrameworkRunSummary, TestHistoryEntry, TestHistoryPage} from "../../../../packages/core/src/types/test-history.types";
import type {FrameworkRun} from "../../../../packages/core/src/types/framework-run.types";
import {api} from "../lib/api";
import {testRunLocation} from "../lib/test-run-links";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";

type CatalogRow = RoutineEnrollment & {example: CatalogExample | null; latestAttempt?: CatalogHistoryRun | null};
type Detail = CatalogRow & {history: CatalogHistoryRun[]; nextCursor: string | null};
const PANEL = "rounded-2xl border border-[#e0e4de] bg-white p-5";
export function routineHref(id: string, platform: string) {
  return `/?routineCatalog=1&routine=${encodeURIComponent(id)}&platform=${encodeURIComponent(platform)}`;
}

export function RoutineCatalogPage() {
  const query = new URLSearchParams(window.location.search);
  const runId = query.get("frameworkRun");
  if (runId) return <FrameworkRunPage runId={runId} />;
  const id = query.get("routine"), platform = query.get("platform");
  return id && platform ? <RoutineDetailPage id={id} platform={platform} /> : <RoutineCatalogList />;
}

function RoutineCatalogList() {
  const catalog = useQuery({queryKey: ["routine-catalog"],
    queryFn: () => api<{routines: CatalogRow[]}>("/api/admin/routine-catalog"), refetchInterval: 15000});
  if (catalog.isPending) return <p role="status">Loading routines…</p>;
  if (catalog.error && !catalog.data) return <p role="alert">Could not load routines: {catalog.error.message}</p>;
  return <div className="space-y-5">
    <section className={PANEL}><h2 className="text-lg font-semibold">Routine catalog</h2>
      <p className="mt-2">Routines with a published passing example, their requirements and run history.</p></section>
    {catalog.error && <p role="alert">Routines could not refresh: {catalog.error.message}</p>}
    {!catalog.data.routines.length && <p>No routine has a published passing example on the new framework yet.</p>}
    <div className="grid gap-5 lg:grid-cols-2">{catalog.data.routines.map(row => <RoutineCatalogCard key={`${row.routineId}/${row.platform}`} routine={row} />)}</div>
  </div>;
}

export function RoutineCatalogCard({routine}: {routine: CatalogRow}) {
  return <article className={PANEL}>
    <p className="text-sm text-[#68746d]">{routine.platform === "android" ? "Android" : "iOS on Mac"}</p>
    <h3 className="mt-2 text-lg font-semibold"><a className="underline" href={routineHref(routine.routineId, routine.platform)}>{routine.definition.title}</a></h3>
    <p className="mt-2">{routine.definition.purpose}</p>
    <p className="mt-4">{routine.example ? "Complete passing example available" : "Awaiting a published passing example"}</p>
    {routine.latestAttempt && <p className="mt-2 text-sm">Latest attempt: <a className="underline" href={frameworkRunHref(routine.latestAttempt.runId)}>{routine.latestAttempt.outcome}</a> · {new Date(routine.latestAttempt.startedAt).toLocaleString()}{routine.latestAttempt.definitionRevision !== routine.definitionRevision && " · earlier definition"}</p>}
    {routine.example && <p className="mt-2 text-sm text-[#68746d]">Example: {new Date(routine.example.startedAt).toLocaleString()} · revision <code>{routine.example.definitionRevision.slice(0, 8)}</code>{routine.example.definitionRevision !== routine.definitionRevision && " · earlier definition"}</p>}
  </article>;
}

function RoutineDetailPage({id, platform}: {id: string; platform: string}) {
  const detail = useInfiniteQuery({queryKey: ["routine-detail", id, platform], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => api<Detail>(`/api/admin/routine-catalog/${encodeURIComponent(id)}/${encodeURIComponent(platform)}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 15000});
  if (detail.isPending) return <p role="status">Loading routine…</p>;
  if (detail.error && !detail.data) return <p role="alert">Could not load routine: {detail.error.message}</p>;
  const row = detail.data.pages[0]!, definition = row.definition;
  return <div className="space-y-5">
    <a href="/?routineCatalog=1" className="underline">All routines</a>
    {detail.error && <p role="alert">Routine could not refresh: {detail.error.message}</p>}
    <section className={PANEL}><h2 className="text-xl font-semibold">{definition.title}</h2><p className="mt-2">{definition.purpose}</p>
      {row.example ? <div className="mt-4"><video className="w-full rounded-lg" controls preload="metadata"
        src={`/api/admin/routine-catalog/results/by-run/${encodeURIComponent(row.example.runId)}/assets/${encodeURIComponent(row.example.recordingAssetId)}`} />
        <p className="mt-2 text-sm">Recorded {new Date(row.example.startedAt).toLocaleString()} · {row.platform} · build <code>{row.example.build.headSha}</code></p>
        <p className="mt-1 text-sm">Example definition: <code>{row.example.definitionRevision}</code>{row.example.definitionRevision !== row.definitionRevision && " (earlier than the current definition)"}</p>
        <a className="mt-2 block underline" href={frameworkRunHref(row.example.runId)}>Open passing run</a></div>
        : <p className="mt-4">Awaiting a published passing recording.</p>}
    </section>
    <section className={PANEL}><h3 className="font-semibold">Requirements</h3>
      <p className="mt-2">Starts from {definition.entry === "home" ? "Home" : "Sign in"}. Account: {definition.account === "lane" ? "dedicated lane account" : "none"}.</p>
      <ul className="mt-3 list-disc pl-5">{definition.requirements.map(text => <li key={text}>{text}</li>)}</ul>
      {definition.fixtures.map(fixture => <p className="mt-2" key={fixture.provider}>{fixture.description}</p>)}
      <h3 className="mt-5 font-semibold">Steps</h3><ol className="mt-3 list-decimal space-y-2 pl-5">{definition.steps.map(step => <li key={step.id}>{step.instruction}<p className="text-sm text-[#68746d]">Expected: {step.expected}</p></li>)}</ol>
      <p className="mt-4 text-xs">Source revision: <code>{row.definitionRevision}</code></p>
    </section>
    <section className={PANEL}><h3 className="font-semibold">Run history</h3>
      {!row.history.length && <p className="mt-3">No runs yet.</p>}
      <ul className="mt-3 space-y-2">{detail.data.pages.flatMap(page => page.history).map(run => <li key={run.runId}>
        <a className="underline" href={frameworkRunHref(run.runId)}>{new Date(run.startedAt).toLocaleString()}</a>
        {" · "}{run.outcome}{run.evidenceStatus === "failed" && " · evidence failed"}{!run.uploadsComplete && " · evidence pending"}</li>)}</ul>
      {detail.hasNextPage && <button className="mt-4 underline" disabled={detail.isFetchingNextPage} onClick={() => detail.fetchNextPage()}>More runs</button>}
    </section>
  </div>;
}

export function frameworkRunHref(runId: string) {
  return testRunLocation("https://admin.mentraglass.com/", {runID: runId});
}

export function FrameworkRunPage({runId, stepId}: {runId: string; stepId?: string}) {
  const video = useRef<HTMLVideoElement>(null);
  const pendingOffset = useRef<number | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | undefined>(stepId);
  const [stepSearch, setStepSearch] = useState("");
  const result = useQuery({queryKey: ["framework-run", runId], queryFn: () =>
    api<{run: FrameworkRun; definition: RoutineEnrollment["definition"] | null; outcome: string; uploadsComplete: boolean; evidenceStatus: "complete" | "failed"}>(`/api/admin/routine-catalog/results/by-run/${encodeURIComponent(runId)}`),
    refetchInterval: query => query.state.data?.uploadsComplete === false ? 5000 : false});
  useEffect(() => {
    if (!stepId) return;
    setSelectedStep(stepId);
    const step = result.data?.run.result.steps.find(item => item.id === stepId);
    if (step?.recordingLocation) {
      pendingOffset.current = step.recordingLocation.startOffsetMs / 1000;
      setSelectedAsset(step.recordingLocation.assetId);
      if (video.current?.readyState && video.current.dataset.assetId === step.recordingLocation.assetId) {
        video.current.currentTime = pendingOffset.current; pendingOffset.current = null;
      }
    } else {pendingOffset.current = null; setSelectedAsset(null);}
  }, [runId, stepId, result.data?.run]);
  useEffect(() => {setStepSearch(""); setSelectedStep(stepId); if (!stepId) {pendingOffset.current = null; setSelectedAsset(null);}}, [runId, stepId]);
  if (result.isPending) return <p role="status">Loading run…</p>;
  if (result.error && !result.data) return <p role="alert">Could not load run: {result.error.message}</p>;
  const {run, definition, outcome, uploadsComplete, evidenceStatus} = result.data;
  const recordingAsset = selectedAsset ?? run.recordingAssetId;
  const seekStep = (id: string, location: NonNullable<FrameworkRun["result"]["steps"][number]["recordingLocation"]>) => {
    setSelectedStep(id);
    pendingOffset.current = location.startOffsetMs / 1000;
    setSelectedAsset(location.assetId);
    if (recordingAsset === location.assetId && video.current?.readyState) {
      video.current.currentTime = pendingOffset.current;
      pendingOffset.current = null;
    }
    video.current?.scrollIntoView({block: "nearest", behavior: "smooth"});
  };
  const assetHref = (id: string) => `/api/admin/routine-catalog/results/by-run/${encodeURIComponent(runId)}/assets/${encodeURIComponent(id)}`;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} seconds`;
  const hasRecording = Boolean(recordingAsset && uploadsComplete);
  const definitionSteps = new Map(definition?.steps.map(step => [step.id, step]) ?? []);
  const visibleSteps = run.result.steps.map((step, index) => ({step, index, source: definitionSteps.get(step.id)}))
    .filter(({step, source}) => matchesStepSearch(step, source, stepSearch));
  return <div className="space-y-5">
    <a className="underline" href={routineHref(run.routineId, run.platform)}>Back to routine</a>
    {result.error && <p role="alert">Run could not refresh: {result.error.message}</p>}
    <section className={PANEL}><h2 className="text-xl font-semibold">{run.routineId}: {outcome}</h2>
      <p className="mt-2">Started {new Date(run.startedAt).toLocaleString()} · Finished {new Date(run.finishedAt).toLocaleString()}</p>
      <p className="mt-2 text-sm">Run <code>{runId}</code> · Request <code>{run.requestId}</code></p>
      <p className="mt-2"><BuildIdentity build={run.build} /></p>
      {definition?.source && <p className="mt-2 text-sm"><a className="underline" href={definitionSourceHref(definition.source)} target="_blank" rel="noreferrer">Routine source at {definition.source.revision.slice(0, 10)}</a></p>}
      <p className="mt-2">Computer: {run.hostId} · Lane: {run.laneId} · {run.platform}</p>
      <p className="mt-2">Setup {seconds(run.result.timing.setupMs)} · Test {seconds(run.result.timing.testMs)} · Teardown {seconds(run.result.timing.teardownMs)}</p>
      {evidenceStatus === "failed" && <p role="alert" className="mt-2">Evidence failed; the execution verdict is unchanged.</p>}
      {!uploadsComplete && <p role="status" className="mt-2">Evidence upload pending.</p>}
    </section>
    <LifecyclePanel phase="setup" actions={run.result.setup.actions} status={run.result.setup.status}
      durationMs={run.result.timing.setupMs} failures={run.result.failures.filter(failure => failure.phase === "setup")} />
    <div className={hasRecording ? "grid gap-5 lg:h-[calc(100dvh-var(--admin-header-height,6rem)-2rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" : "space-y-5"}>
    {hasRecording && <section aria-label="Run recording" className={`${PANEL} order-1 min-w-0 lg:order-2 lg:flex lg:min-h-0 lg:flex-col`}>
      <h3 className="shrink-0 font-semibold">Recording</h3>
      <div className="mt-3 lg:min-h-0 lg:flex-1"><video ref={video} data-asset-id={recordingAsset!} className="max-h-[70dvh] w-full scroll-mt-[calc(var(--admin-header-height,6rem)+1rem)] rounded-lg bg-black object-contain lg:h-full lg:max-h-none" controls preload="metadata" src={assetHref(recordingAsset!)} onLoadedMetadata={() => {
        if (video.current && pendingOffset.current !== null) {video.current.currentTime = pendingOffset.current; pendingOffset.current = null;}
      }} /></div>
    </section>}
    <section aria-label="Execution steps" className={`${PANEL} min-w-0 ${hasRecording ? "order-2 lg:order-1 lg:flex lg:min-h-0 lg:flex-col" : ""}`}><h3 className="shrink-0 font-semibold">Execution</h3>
      <label className="mt-3 block shrink-0 text-sm">Search steps<input type="search" className="mt-1 block w-full rounded-lg border border-[#cbd3c8] p-2" value={stepSearch} onChange={event => setStepSearch(event.target.value)} placeholder="Instruction, expected result or step ID" /></label>
      <div role="region" aria-label="Execution details" tabIndex={0} className={`mt-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 ${hasRecording ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2" : ""}`}>
      {!visibleSteps.length && <p className="mt-3">No steps match your search.</p>}
      <ol role="list" className="mt-3 list-none space-y-2">{visibleSteps.map(({step, index, source}) => {
        const title = source?.instruction ?? step.id;
        return <li key={step.id} className={`flex gap-3 rounded-lg border p-3 ${selectedStep === step.id ? "border-[#3b7650] bg-[#edf6ef]" : "border-[#e0e4de]"}`}>
          <span aria-hidden="true" className="w-7 shrink-0 text-right">{index + 1}.</span>
          <div className="min-w-0 flex-1">
          {step.recordingLocation && uploadsComplete ? <button className="block w-full text-left" aria-current={selectedStep === step.id ? "step" : undefined} onClick={() => seekStep(step.id, step.recordingLocation!)}><span className="underline">{title}</span> <StepStatus status={step.status} /> · {seconds(step.durationMs)}<span className="block text-sm">Watch this step · {recordingOffset(step.recordingLocation.startOffsetMs)}</span></button>
            : <p>{title} <StepStatus status={step.status} />{step.status !== "not-run" && ` · ${seconds(step.durationMs)}`}<span className="block text-sm text-[#68746d]">{step.status === "not-run" ? "Not executed" : "Recording location unavailable"}</span></p>}
          {source && <p className="mt-1 text-sm">Expected: {source.expected}</p>}
          {step.causedBy && <p className="mt-1 text-sm">Caused by: {step.causedBy}</p>}
          </div>
        </li>;
      })}</ol>
      {run.result.failures.filter(failure => failure.phase === "test").map((failure, index) => <p role="alert" className="mt-2 whitespace-pre-wrap" key={index}>{failure.actionId}: {failure.message}</p>)}
      </div>
    </section>
    </div>
    <LifecyclePanel phase="teardown" actions={run.result.teardown.actions} status={run.result.teardown.ready ? "passed" : "failed"}
      durationMs={run.result.timing.teardownMs} failures={run.result.failures.filter(failure => failure.phase === "teardown")}
      unavailable={run.result.teardown.unavailableResources} />
    <section className={PANEL}><h3 className="font-semibold">Evidence</h3>
      {run.result.failures.filter(failure => failure.phase === "evidence").map((failure, index) => <p role="alert" className="mt-2 whitespace-pre-wrap" key={index}>{failure.actionId}: {failure.message}</p>)}
      <ul className="mt-3 space-y-2">{run.assets.map(asset => <li key={asset.id}>{uploadsComplete ? <a className="underline" href={assetHref(asset.id)}>{asset.path}</a> : asset.path} · {asset.kind}</li>)}</ul>
      <p className="mt-4 text-xs">Source revision: <code>{run.definitionRevision}</code></p>
    </section>
  </div>;
}

type LifecycleAction = NonNullable<FrameworkRun["result"]["setup"]["actions"]>[number];
function LifecyclePanel({phase, actions, status, durationMs, failures, unavailable = []}: {
  phase: "setup" | "teardown";
  actions?: LifecycleAction[];
  status: "passed" | "failed" | "cancelled";
  durationMs: number;
  failures: FrameworkRun["result"]["failures"];
  unavailable?: FrameworkRun["result"]["teardown"]["unavailableResources"];
}) {
  const title = phase === "setup" ? "Setup" : "Teardown";
  const routine = actions?.filter(action => action.scope === "routine");
  const shared = actions?.filter(action => action.scope === "shared");
  const actionList = (items: LifecycleAction[]) => <ol className="mt-3 space-y-2">{items.map((action, index) => <li key={action.id}
    className="flex gap-3 rounded-lg border border-[#e0e4de] p-3">
    <span aria-hidden="true" className="w-7 shrink-0 text-right">{index + 1}.</span>
    <div className="min-w-0 flex-1"><p>{action.instruction} <StepStatus status={action.status} />
      {action.status !== "not-run" && ` · ${(action.durationMs / 1000).toFixed(1)} seconds`}</p>
      <p className="mt-1 text-sm text-[#68746d]">Expected: {action.expected}</p>
      {action.startedAt && <p className="mt-1 text-sm">Started {new Date(action.startedAt).toLocaleTimeString()}
        {action.finishedAt && ` · Finished ${new Date(action.finishedAt).toLocaleTimeString()}`}</p>}
      {action.causedBy && <p className="mt-1 text-sm">Caused by: {action.causedBy}</p>}
    </div>
  </li>)}</ol>;
  return <section aria-label={`${title} details`} className={PANEL}>
    <h3 className="font-semibold">{title} <StepStatus status={status} /> · {(durationMs / 1000).toFixed(1)} seconds</h3>
    <h4 className="mt-4 text-sm font-semibold">Routine {phase}</h4>
    {routine === undefined ? <p className="mt-2 text-sm text-[#68746d]">Routine-specific {phase} details were not recorded for this run.</p>
      : routine.length ? actionList(routine) : <p className="mt-2 text-sm text-[#68746d]">No routine-specific {phase} steps.</p>}
    {!!shared?.length && <details className="mt-4"><summary className="cursor-pointer text-sm font-semibold">Shared framework {phase} · {shared.length} {shared.length === 1 ? "action" : "actions"}</summary>{actionList(shared)}</details>}
    {failures.map((failure, index) => <p role="alert" className="mt-2 whitespace-pre-wrap" key={index}>{failure.actionId}: {failure.message}</p>)}
    {unavailable.map(resource => <p role="alert" className="mt-2 whitespace-pre-wrap" key={resource.resource}>{resource.resource}: {resource.cause}. Next action: {resource.nextAction}</p>)}
  </section>;
}

export function FrameworkRunsPage({scope}: {scope?: Record<string, string>}) {
  return scope ? <FilteredFrameworkRunsPage scope={scope}/> : <TestHistoryList/>;
}
function TestHistoryList() {
  const history = useInfiniteQuery({queryKey: ["test-history"], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => api<TestHistoryPage>(`/api/admin/test-runs/history/list?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 15000});
  if (history.isPending) return <p role="status">Loading test history…</p>;
  if (history.error && !history.data) return <p role="alert">Could not load test history: {history.error.message}</p>;
  const entries = history.data.pages.flatMap(page => page.entries);
  return <section className={PANEL}><h2 className="text-xl font-semibold">Test history</h2>
    <p className="mt-2 text-sm text-[#68746d]">Dispatched test suites and standalone routine runs, newest first.</p>
    {history.error && <p role="alert" className="mt-3">History could not refresh: {history.error.message} <button className="underline" onClick={() => history.refetch()}>Retry</button></p>}
    {!entries.length && <p className="mt-3">No test suites or routine runs yet.</p>}
    <ul className="mt-4 space-y-3">{entries.map(entry => <TestHistoryItem key={entry.kind === "unavailable" ? `${entry.sourceKind}:${entry.id}` : `${entry.kind}:${entry.kind === "suite" ? entry.suiteId : entry.runId}`} entry={entry}/>)}</ul>
    {history.hasNextPage && <button className="mt-4 underline" disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>{history.isFetchingNextPage ? "Loading…" : "More history"}</button>}
  </section>;
}
function TestHistoryItem({entry}: {entry: TestHistoryEntry}) {
  if (entry.kind === "unavailable") return <li className="rounded-lg border border-[#e0e4de] p-4">
    <a className="font-semibold underline" href={entry.sourceKind === "run" ? frameworkRunHref(entry.id) : `/?testSuite=${encodeURIComponent(entry.id)}`}>{entry.sourceKind === "run" ? "Routine run" : "Test suite"} · {entry.id} · {new Date(entry.startedAt).toLocaleString()}</a>
    <p role="alert" className="mt-1 text-sm">{entry.message}</p>
  </li>;
  if (entry.kind === "run") return <FrameworkRunListItem run={entry}/>;
  return <li className="rounded-lg border border-[#e0e4de] p-4">
    <a className="font-semibold underline" href={`/?testSuite=${encodeURIComponent(entry.suiteId)}`}>{entry.channel} {entry.trigger} suite · {new Date(entry.startedAt).toLocaleString()}</a> · {entry.outcome} · {entry.passed}/{entry.expectedCount} passed
    <p className="mt-1 text-sm">Suite <code>{entry.suiteId}</code>{entry.finishedAt ? ` · Finished ${new Date(entry.finishedAt).toLocaleString()}` : " · In progress"}</p>
    <p className="mt-1 text-sm"><BuildIdentity build={{...entry.build, channel: entry.channel}}/></p>
  </li>;
}
function FilteredFrameworkRunsPage({scope}: {scope: Record<string, string>}) {
  const params = new URLSearchParams(scope);
  const query = useQuery({queryKey: ["framework-runs", params.toString()], queryFn: () => api<{runs: FrameworkRunSummary[]}>(`/api/admin/routine-catalog/results?${params}`), refetchInterval: 15000});
  if (query.isPending) return <p role="status">Loading runs…</p>;
  if (query.error && !query.data) return <p role="alert">Could not load runs: {query.error.message}</p>;
  return <section className={PANEL}><h2 className="text-xl font-semibold">Filtered routine runs</h2>
    {query.error && <p role="alert" className="mt-3">Runs could not refresh: {query.error.message}</p>}
    {!query.data.runs.length && <p className="mt-3">No routine runs match this build.</p>}
    <ul className="mt-4 space-y-3">{query.data.runs.map(run => <FrameworkRunListItem key={run.requestId} run={run}/>)}</ul>
  </section>;
}
function FrameworkRunListItem({run}: {run: FrameworkRunSummary}) {
  return <li className="rounded-lg border border-[#e0e4de] p-4">
    <a className="font-semibold underline" href={frameworkRunHref(run.runId)}>{run.routineId} · {run.platform} · {new Date(run.startedAt).toLocaleString()}</a> · {run.outcome} · {((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} seconds
    <p className="mt-1 text-sm">Run <code>{run.runId}</code> · {run.hostId}/{run.laneId}</p><p className="mt-1 text-sm"><BuildIdentity build={run.build}/></p>
    {run.evidenceStatus === "failed" && <p className="mt-1">Evidence failed</p>}{!run.uploadsComplete && <p className="mt-1">Evidence upload pending</p>}
  </li>;
}

export function recordingOffset(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function matchesStepSearch(step: FrameworkRun["result"]["steps"][number], source: RoutineEnrollment["definition"]["steps"][number] | undefined, search: string) {
  return `${step.id} ${source?.instruction ?? ""} ${source?.expected ?? ""} ${step.status}`.toLowerCase().includes(search.trim().toLowerCase());
}
function StepStatus({status}: {status: FrameworkRun["result"]["steps"][number]["status"] | "cancelled"}) {
  return <span className={`ml-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${status === "passed" ? "bg-green-100 text-green-800" : status === "failed" ? "bg-red-100 text-red-800" : status === "cancelled" ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-700"}`}>{status === "not-run" ? "Not run" : status === "cancelled" ? "Cancelled" : status}</span>;
}
function definitionSourceHref(source: RoutineEnrollment["definition"]["source"]) {
  return `https://github.com/${source.repository}/blob/${source.revision}/${source.path.split("/").map(encodeURIComponent).join("/")}`;
}
function BuildIdentity({build}: {build: {channel: string; headSha: string; repository?: string; release?: unknown; releaseIdentity?: unknown; producerUrl?: unknown}}) {
  const href = build.repository && /^[\w-]+\/[\w.-]+$/.test(build.repository) && /^[a-f0-9]{40}$/.test(build.headSha) ? `https://github.com/${build.repository}/commit/${build.headSha}` : null;
  const producer = typeof build.producerUrl === "string" && /^https:\/\/github\.com\/Mentra-Community\//.test(build.producerUrl) ? build.producerUrl : null;
  const release = typeof build.releaseIdentity === "string" ? build.releaseIdentity : typeof build.release === "string" ? build.release : null;
  return <>Tested build: {build.channel}{release && ` · ${release}`} · {href ? <a className="underline" href={href} target="_blank" rel="noreferrer"><code>{build.headSha.slice(0, 10)}</code></a> : <code>{build.headSha.slice(0, 10)}</code>}{producer && <> · <a className="underline" href={producer} target="_blank" rel="noreferrer">Build job</a></>}</>;
}
