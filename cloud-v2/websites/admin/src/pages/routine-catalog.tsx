import {LoadingIndicator} from "../components/loading-indicator";
import {HistoryStatus, runDisplayStatus} from "../components/test-history-table";
import {TESTING_PANEL, TESTING_LINK, TESTING_FIELD, TestingButton} from "../components/testing-ui";
import {elapsedDuration, runDuration} from "../lib/run-duration";
import {RunRerunLinks} from "./test-reruns";
import {useEffect, useId, useRef, useState} from "react";
import {useInfiniteQuery, useQuery, useQueryClient} from "@tanstack/react-query";
import type {CatalogExample, CatalogHistoryRun, RoutineCatalogCard as CatalogCard, FrameworkRunSummary, FrameworkRunPage as ScopedRunPage, TestHistoryEntry, TestHistoryPage} from "../../../../packages/core/src/types/test-history.types";
import type {FrameworkRun, RecordedFrameworkRun} from "../../../../packages/core/src/types/framework-run.types";
import {api} from "../lib/api";
import {RoutineSearch, useRoutineSearch, matchesRoutineSearch, hasRoutineFilters, type RoutineSearchFilters, type SearchableRoutine} from "../components/routine-search";
import {RecordingVideo} from "../components/recording-video";
import {Switch} from "../components/ui/switch";
import {TestHistoryTable} from "../components/test-history-table";
import {testRunLocation} from "../lib/test-run-links";
import type {RoutineEnrollment, RoutineCardDefinition} from "../../../../packages/core/src/types/routine-definition.types";
import type {FrameworkRequestDisplay} from "../../../../packages/core/src/types/framework-request.types";

type CatalogRow = RoutineEnrollment & {example: CatalogExample | null; latestAttempt?: CatalogHistoryRun | null; nightlyEnabled?: boolean};
type Detail = CatalogRow & {history: CatalogHistoryRun[]; nextCursor: string | null};
type CardRow = RoutineCardDefinition & Pick<CatalogRow, 'example' | 'latestAttempt' | 'nightlyEnabled'>;
const PANEL = TESTING_PANEL;
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

function searchableRoutine(routine: RoutineCardDefinition): SearchableRoutine {
  return {title: routine.definition.title, purpose: routine.definition.purpose, platform: routine.platform, glassesModels: routine.definition.glasses?.models ?? []};
}
export function matchesCatalogSearch(routine: RoutineCardDefinition, search: string, platform: string, glasses: string) {
  return matchesRoutineSearch(searchableRoutine(routine), {search, platform, glasses});
}
export const routineCatalogOverviewQuery = {queryKey: ["routine-catalog"],
  queryFn: () => api<{routines: CatalogCard[]}>("/api/admin/routine-catalog/overview"), refetchInterval: 15000};
function useSearchCatalog() {return useQuery(routineCatalogOverviewQuery);}
function runSearchMetadata(run: {routineId: string; platform: string}, routines: RoutineCardDefinition[]): SearchableRoutine {
  const routine = routines.find(row => row.routineId === run.routineId && row.platform === run.platform);
  return routine ? searchableRoutine(routine) : {title: run.routineId, platform: run.platform};
}
export function matchesBuildSearch(build: {headSha: string; prNumber?: number; release?: string}, search: string) {
  const text = search.trim().toLowerCase();
  if (!text) return false;
  const pr = text.match(/^(?:#|pr\s*#?\s*)?(\d+)$/);
  return build.release?.toLowerCase().includes(text) === true
    || !!pr && build.prNumber !== undefined && Number(pr[1]) === build.prNumber
    || /^[a-f0-9]{4,40}$/.test(text) && build.headSha.toLowerCase().startsWith(text);
}
export function matchesHistorySearch(entry: TestHistoryEntry, routines: RoutineCardDefinition[], filters: RoutineSearchFilters) {
  if (!hasRoutineFilters(filters)) return true;
  if (entry.kind === "unavailable") return false;
  const buildMatch = matchesBuildSearch(entry.build, filters.search);
  const memberFilters = buildMatch ? {...filters, search: ""} : filters;
  if (buildMatch && !filters.platform && !filters.glasses) return true;
  const members = entry.kind === "suite" ? entry.members ?? [] : [entry];
  return members.some(member => matchesRoutineSearch(runSearchMetadata(member, routines), memberFilters));
}
export function RoutineCatalogList() {
  const [filters, setFilters] = useRoutineSearch();
  const catalog = useSearchCatalog();
  if (catalog.isPending) return <LoadingIndicator label="Loading routines" />;
  if (catalog.error && !catalog.data) return <p role="alert">Could not load routines: {catalog.error.message}</p>;
  const routines = catalog.data.routines;
  const filtered = routines.filter(row => matchesRoutineSearch(searchableRoutine(row), filters));
  return <div className="space-y-5">
    <section className={PANEL} aria-label="Routine filters">
      <RoutineSearch filters={filters} onChange={setFilters} routines={routines.map(searchableRoutine)} countLabel={`Showing ${filtered.length} of ${routines.length} routines`} />
    </section>
    {catalog.error && <p role="alert">Routines could not refresh: {catalog.error.message}</p>}
    {!routines.length ? <p>No routine has a published passing example on the new framework yet.</p>
      : !filtered.length && <p>No routines match your filters. Try another search or clear the filters.</p>}
    <div className="grid gap-5 lg:grid-cols-2">{filtered.map(row => <EditableRoutineCatalogCard key={`${row.routineId}/${row.platform}`} routine={row} />)}</div>
  </div>;
}

function EditableRoutineCatalogCard({routine}: {routine: CardRow}) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const update = async (nightlyEnabled: boolean) => {
    setSaving(true); setError(null);
    try {
      await api(`/api/admin/routines/${encodeURIComponent(routine.routineId)}/platforms/${encodeURIComponent(routine.platform)}/preferences`, {method: "PATCH", body: {nightlyEnabled}});
      client.setQueryData<{routines: CatalogCard[]}>(["routine-catalog"], current => current && ({routines: current.routines.map(row => row.routineId === routine.routineId && row.platform === routine.platform ? {...row, nightlyEnabled} : row)}));
      await client.invalidateQueries({queryKey: ["routine-catalog"]});
    } catch (cause) {setError(cause instanceof Error ? cause.message : "Could not save nightly preference.");}
    finally {setSaving(false);}
  };
  return <RoutineCatalogCard routine={routine} onNightlyChange={update} saving={saving} preferenceError={error} />;
}

export function RoutineCatalogCard({routine, onNightlyChange, saving = false, preferenceError}: {routine: CardRow; onNightlyChange?: (enabled: boolean) => void; saving?: boolean; preferenceError?: string | null}) {
  return <article className={PANEL}>
    <p className="text-sm text-[#68746d]">{routine.platform === "android" ? "Android" : "iOS on Mac"}</p>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1"><h3 className="text-lg font-semibold"><a className={TESTING_LINK} href={routineHref(routine.routineId, routine.platform)}>{routine.definition.title}</a></h3>
      <Switch aria-label={`${routine.definition.title}: Runs nightly`} checked={routine.nightlyEnabled ?? true} disabled={saving} onChange={event => onNightlyChange?.(event.target.checked)}>Runs nightly</Switch></div>
    {preferenceError && <p role="alert" className="mt-2 text-sm">{preferenceError}</p>}
    {routine.latestAttempt && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#747780]">
      <span>Latest</span>
      <a className={TESTING_LINK} href={frameworkRunHref(routine.latestAttempt.runId)} aria-label={`Latest run: ${runDisplayStatus(routine.latestAttempt.outcome, routine.latestAttempt.evidenceStatus, routine.latestAttempt.uploadsComplete)}`}>
        <HistoryStatus outcome={runDisplayStatus(routine.latestAttempt.outcome, routine.latestAttempt.evidenceStatus, routine.latestAttempt.uploadsComplete)} />
      </a>
      <time dateTime={routine.latestAttempt.startedAt} title={new Date(routine.latestAttempt.startedAt).toLocaleString()}>{new Date(routine.latestAttempt.startedAt).toLocaleString(undefined, {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"})}</time>
      {routine.latestAttempt.definitionRevision !== routine.definitionRevision && <span>Earlier source</span>}
    </div>}
    <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#eceeeb] pt-3">
      {routine.example ? <a className={TESTING_LINK} href={frameworkRunHref(routine.example.runId)}>{routine.example.definitionRevision !== routine.definitionRevision ? "Earlier passing example" : "Passing example"}</a> : <span className="text-xs text-[#747780]">Passing example pending</span>}
      <a className={TESTING_LINK} href={`${routineHref(routine.routineId, routine.platform)}#run-history`}>Run history</a>
    </div>
    <details className="mt-3 text-sm text-[#747780]">
      <summary className="w-fit cursor-pointer rounded-sm text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#111217]">Details</summary>
      <div className="mt-3 space-y-2 break-words">
        <p>{routine.definition.purpose}</p>
        <p>Current source: <code className="break-all">{routine.definitionRevision}</code></p>
        {routine.latestAttempt && <p>Latest run source: <code className="break-all">{routine.latestAttempt.definitionRevision}</code>{routine.latestAttempt.definitionRevision !== routine.definitionRevision && " (earlier definition)"}</p>}
        {routine.example && <>
          <p>Example recorded {new Date(routine.example.startedAt).toLocaleString()}.</p>
          <p>Example source: <code className="break-all">{routine.example.definitionRevision}</code>{routine.example.definitionRevision !== routine.definitionRevision && " (earlier definition; this recording does not qualify the current source)"}</p>
        </>}
      </div>
    </details>
  </article>;
}

function RoutineDetailPage({id, platform}: {id: string; platform: string}) {
  const detail = useInfiniteQuery({queryKey: ["routine-detail", id, platform], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => api<Detail>(`/api/admin/routine-catalog/${encodeURIComponent(id)}/${encodeURIComponent(platform)}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 15000});
  if (detail.isPending) return <LoadingIndicator label="Loading routine" />;
  if (detail.error && !detail.data) return <p role="alert">Could not load routine: {detail.error.message}</p>;
  const row = detail.data.pages[0]!, definition = row.definition;
  return <div className="space-y-5">
    <a href="/?routineCatalog=1" className={TESTING_LINK}>All routines</a>
    {detail.error && <p role="alert">Routine could not refresh: {detail.error.message}</p>}
    <section className={PANEL}><h2 className="text-xl font-semibold">{definition.title}</h2><p className="mt-2">{definition.purpose}</p>
      {row.example ? <div className="mt-4"><RecordingVideo
        className="max-w-[44rem]" src={`/api/admin/routine-catalog/results/by-run/${encodeURIComponent(row.example.runId)}/assets/${encodeURIComponent(row.example.recordingAssetId)}`} />
        <p className="mt-2 text-sm">Recorded {new Date(row.example.startedAt).toLocaleString()} · {row.platform} · build <code title={row.example.build.headSha}>{row.example.build.headSha.slice(0, 10)}</code></p>
        <p className="mt-1 text-sm">Example definition: <code title={row.example.definitionRevision}>{row.example.definitionRevision.slice(0, 10)}</code>{row.example.definitionRevision !== row.definitionRevision && " (earlier than the current definition)"}</p>
        <a className={`${TESTING_LINK} mt-2 block`} href={frameworkRunHref(row.example.runId)}>Open passing run</a></div>
        : <p className="mt-4">Awaiting a published passing recording.</p>}
    </section>
    <section className={PANEL}><h3 className="font-semibold">Requirements</h3>
      <p className="mt-2">Starts from {definition.entry === "home" ? "Home" : "Sign in"}. Account: {definition.account === "lane" ? "dedicated lane account" : "none"}.</p>
      <ul className="mt-3 list-disc pl-5">{definition.requirements.map(text => <li key={text}>{text}</li>)}</ul>
      {definition.fixtures.map(fixture => <p className="mt-2" key={fixture.provider}>{fixture.description}</p>)}
      <h3 className="mt-5 font-semibold">Steps</h3><ol className="mt-3 list-decimal space-y-2 pl-5">{definition.steps.map(step => <li key={step.id}>{step.instruction}<p className="text-sm text-[#68746d]">Expected: {step.expected}</p></li>)}</ol>
      <p className="mt-4 text-xs">Source revision: <code>{row.definitionRevision}</code></p>
    </section>
    <section id="run-history" className={PANEL}><h3 className="font-semibold">Run history</h3>
      {!row.history.length && <p className="mt-3">No runs yet.</p>}
      <ul className="mt-3 space-y-2">{detail.data.pages.flatMap(page => page.history).map(run => <li key={run.runId}>
        <a className={TESTING_LINK} href={frameworkRunHref(run.runId)}>{new Date(run.startedAt).toLocaleString()}</a>
        {" · "}{run.outcome}{run.evidenceStatus === "failed" && " · evidence failed"}{!run.uploadsComplete && " · evidence pending"}</li>)}</ul>
      {detail.hasNextPage && <TestingButton className="mt-4" busy={detail.isFetchingNextPage} onClick={() => detail.fetchNextPage()}>More runs</TestingButton>}
    </section>
  </div>;
}

export function frameworkRunHref(runId: string) {
  return testRunLocation("https://admin.mentraglass.com/", {runID: runId});
}

type RunDisplay = {kind?: "run"; run: RecordedFrameworkRun; definition: RoutineEnrollment["definition"] | null;
  outcome: string; uploadsComplete: boolean; evidenceStatus: "complete" | "failed"};
type RequestDisplay = {kind: "request"; request: FrameworkRequestDisplay; run?: never; uploadsComplete?: never};
const CANCELLED_REQUEST_OBSERVATION_MS = 10 * 60 * 1000;

export function frameworkRunRefetchInterval(data: RunDisplay | RequestDisplay | undefined, observedAt: number, now = Date.now()): number | false {
  if (data?.kind === "request") return data.request.state !== "terminal"
    || (data.request.terminalStatus === "cancelled" && now - observedAt < CANCELLED_REQUEST_OBSERVATION_MS) ? 5000 : false;
  return data?.uploadsComplete === false ? 5000 : false;
}

function RequestCard({request, observing, refreshing, onRefresh}: {request: FrameworkRequestDisplay; observing: boolean; refreshing: boolean; onRefresh: () => void}) {
  const status = request.terminalStatus ?? request.state;
  return <section className={PANEL} aria-label="Routine request">
    <a className={TESTING_LINK} href="/?testRuns=1">All test runs</a>
    <h2 className="mt-4 text-xl font-semibold">{request.routineId}: {status === "not-run" ? "Did not run" : status}</h2>
    <p className="mt-2 text-sm">Request <code>{request.requestId}</code></p>
    <p className="mt-2"><BuildIdentity build={request.build} label="Requested build" /></p>
    <p className="mt-2">Computer: {request.hostId} · Lane: {request.laneId} · {request.platform}</p>
    <p className="mt-2 text-sm">Routine revision: <code>{request.definitionRevision}</code></p>
    {request.minimumFrameworkVersion !== undefined && <p className="mt-2 text-sm">Requires framework version {request.minimumFrameworkVersion} or later.</p>}
    {request.routineSource && <p className="mt-2 text-sm">Requires routine API {request.routineSource.minimumRoutineApiVersion} or later. The installed framework is recorded when execution starts.</p>}
    {!request.routineSource && <p className="mt-2 text-sm">{request.dispatchIntentSha256 ? 'The exact routine source is being prepared before executable input is committed.' : 'Routine bundle provenance unknown: this historical request did not record its source archive.'}</p>}
    {request.createdAt && <p className="mt-2 text-sm">Requested {new Date(request.createdAt).toLocaleString()}</p>}
    {request.acceptedAt && <p className="mt-2 text-sm">Host accepted {new Date(request.acceptedAt).toLocaleString()}</p>}
    {request.reason && <p className="mt-3">{request.reason}</p>}
    {request.cancellationRequested && <p className="mt-2 text-sm">Cancellation requested · {!request.inputSha256 ? "Cancelled before execution." : request.cancellationAcknowledged ? "Host acknowledged; cleanup may still be running." : "Awaiting host acknowledgement."}</p>}
    <p className="mt-3 text-sm text-[#68746d]">No routine result has been published.{request.state !== "terminal" && " This request refreshes automatically."}
      {request.terminalStatus === "cancelled" && (observing ? " Checking for final host custody or a published result for ten minutes." : "Automatic observation has ended. Refresh to check for later host custody or results.")}</p>
    <TestingButton className="mt-3" disabled={refreshing} onClick={onRefresh}>Refresh request</TestingButton>
  </section>;
}

export function runFailureSummary(run: RecordedFrameworkRun, outcome: string, evidenceStatus: string) {
  const phase = outcome === "setup-failed" ? "setup" : outcome === "failed" ? "test" : outcome === "teardown-failed" ? "teardown"
    : evidenceStatus === "failed" ? "evidence" : null;
  if (!phase) return null;
  const failure = run.result.failures.find(item => item.phase === phase);
  const label = {setup: "Setup", test: "Test", teardown: "Teardown", evidence: "Evidence"}[phase];
  const message = failure?.message ?? (phase === "teardown" ? run.result.teardown.unavailableResources[0]?.cause : undefined)
    ?? `${label} failed. No detailed reason was recorded.`;
  const brief = message.trim().split(/\r?\n/)[0]!.replace(/\s+/g, " ");
  return {phase, actionId: failure?.actionId, reason: `${label}: ${brief.length > 160 ? `${brief.slice(0, 157)}…` : brief}`,
    target: failure ? `run-failure-${phase}-0` : `run-phase-${phase}`};
}

export function FrameworkRunPage({runId, stepId}: {runId: string; stepId?: string}) {
  const video = useRef<HTMLVideoElement>(null);
  const [failureTarget, setFailureTarget] = useState<string | null>(null);
  const pendingOffset = useRef<number | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | undefined>(stepId);
  const [stepSearch, setStepSearch] = useState("");
  const [observation, setObservation] = useState<{runId: string; startedAt: number | null}>(() => ({runId, startedAt: null}));
  const observedAt = observation.runId === runId ? observation.startedAt ?? Date.now() : Date.now();
  const result = useQuery({queryKey: ["framework-run", runId], queryFn: () =>
    api<RunDisplay | RequestDisplay>(`/api/admin/test-runs/${encodeURIComponent(runId)}`),
    refetchInterval: query => frameworkRunRefetchInterval(query.state.data, observedAt)});
  useEffect(() => {
    if (result.data?.kind === "request" && result.data.request.terminalStatus === "cancelled")
      setObservation(current => current.runId === runId && current.startedAt !== null ? current : {runId, startedAt: Date.now()});
  }, [runId, result.data?.kind, result.data?.kind === "request" ? result.data.request.terminalStatus : undefined]);
  useEffect(() => {
    if (!stepId) return;
    setSelectedStep(stepId);
    const step = result.data?.run?.result.steps.find(item => item.id === stepId);
    if (step?.recordingLocation) {
      pendingOffset.current = step.recordingLocation.startOffsetMs / 1000;
      setSelectedAsset(step.recordingLocation.assetId);
      if (video.current?.readyState && video.current.dataset.assetId === step.recordingLocation.assetId) {
        video.current.currentTime = pendingOffset.current; pendingOffset.current = null;
      }
    } else {pendingOffset.current = null; setSelectedAsset(null);}
  }, [runId, stepId, result.data?.run]);
  useEffect(() => {setStepSearch(""); setSelectedStep(stepId); if (!stepId) {pendingOffset.current = null; setSelectedAsset(null);}}, [runId, stepId]);
  useEffect(() => {
    if (!failureTarget) return;
    const target = document.getElementById(failureTarget);
    target?.scrollIntoView({block: "center", behavior: "smooth"});
    target?.focus({preventScroll: true});
    setFailureTarget(null);
  }, [failureTarget]);
  if (result.isPending) return <LoadingIndicator label="Loading run" />;
  if (result.error && !result.data) return <p role="alert">Could not load run: {result.error.message}</p>;
  if (result.data.kind === "request") {
    const request = result.data.request;
    return <div className="space-y-5">
      {result.error && <p role="alert">Request could not refresh: {result.error.message}</p>}
      <RequestCard request={request} observing={frameworkRunRefetchInterval(result.data, observedAt) !== false}
        refreshing={result.isFetching} onRefresh={() => {setObservation({runId, startedAt: request.terminalStatus === "cancelled" ? Date.now() : null}); void result.refetch();}} />
    </div>;
  }
  const {run, definition, outcome, uploadsComplete, evidenceStatus} = result.data;
  const failureSummary = runFailureSummary(run, outcome, evidenceStatus);
  const actualRunId = result.data.kind === "run" ? run.result.runId : runId;
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
  const assetHref = (id: string) => `/api/admin/routine-catalog/results/by-run/${encodeURIComponent(actualRunId)}/assets/${encodeURIComponent(id)}`;
  const hasRecording = Boolean(recordingAsset && uploadsComplete);
  const definitionSteps = new Map(definition?.steps.map(step => [step.id, step]) ?? []);
  const visibleSteps = run.result.steps.map((step, index) => ({step, index, source: definitionSteps.get(step.id)}))
    .filter(({step, source}) => matchesStepSearch(step, source, stepSearch));
  return <div className="space-y-5">
    <a className={TESTING_LINK} href={routineHref(run.routineId, run.platform)}>Back to routine</a>
    {result.error && <p role="alert">Run could not refresh: {result.error.message}</p>}
    <section className={PANEL}>
      <div className="flex flex-wrap items-start justify-between gap-3"><h2 className="text-xl font-semibold">{definition?.title ?? run.routineId}</h2>
        <div className="max-w-sm space-y-2 sm:text-right"><HistoryStatus outcome={runDisplayStatus(outcome, evidenceStatus, uploadsComplete)}/>
          {failureSummary && <><p className="text-sm text-[#cf222e]">{failureSummary.reason}</p>
            <TestingButton onClick={() => {setStepSearch(""); setSelectedStep(failureSummary.actionId); setFailureTarget(failureSummary.target);}}>Go to failure</TestingButton></>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-[#747780]">
        <span>{new Date(run.startedAt).toLocaleString()} · {runDuration(run.startedAt, run.finishedAt) ?? "Duration unknown"}</span>
        <span>{run.hostId} / {run.laneId} · {run.platform === "ios-on-mac" ? "iOS on Mac" : run.platform}</span>
        <span>Setup {elapsedDuration(run.result.timing.setupMs)} · Test {elapsedDuration(run.result.timing.testMs)} · Teardown {elapsedDuration(run.result.timing.teardownMs)}</span>
      </div>
      <p className="mt-3 text-sm">Execution: {outcome === "pass" ? "Passed" : outcome.replaceAll("-", " ")}</p>
      <p className="mt-3 text-sm"><BuildIdentity build={run.build} /></p>
      <RunRerunLinks requestId={run.requestId}/>
      <details className="mt-3 border-t border-[#eceeeb] pt-3 text-xs text-[#747780]"><summary className="cursor-pointer font-medium">Run provenance</summary>
        <dl className="mt-3 space-y-2 break-words"><div>Run <code>{actualRunId}</code> · Request <code>{run.requestId}</code></div>
          <div>Started {new Date(run.startedAt).toLocaleString()} · Finished {new Date(run.finishedAt).toLocaleString()}</div>
          {definition?.source && <div><a className={TESTING_LINK} href={definitionSourceHref(definition.source)} target="_blank" rel="noreferrer">Routine source at {definition.source.revision.slice(0, 10)}</a></div>}
          <div>{run.frameworkBinding ? <>Framework {run.frameworkBinding.version} · <code>{run.frameworkBinding.revision.slice(0, 10)}</code> · Routine API {run.frameworkBinding.routineApiVersion}</>
            : "Framework provenance unknown: this historical result did not record its installed framework."}</div>
          {!run.routineSource && <div>Routine bundle provenance unknown: this historical result did not record its source archive.</div>}
        </dl>
      </details>
      {evidenceStatus === "failed" && <p role="alert" className="mt-3 text-sm text-[#cf222e]">Evidence failed; the execution verdict is unchanged.</p>}
      {!uploadsComplete && <p role="status" className="mt-3 text-sm text-[#747780]">Evidence upload pending.</p>}
    </section>
    <LifecyclePanel phase="setup" actions={run.result.setup.actions} status={run.result.setup.status}
      actionId={run.result.setup.actionId} durationMs={run.result.timing.setupMs} failures={run.result.failures.filter(failure => failure.phase === "setup")} />
    <div className={hasRecording ? "grid gap-5 lg:h-[calc(var(--recording-height)+5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" : "space-y-5"}>
    {hasRecording && <section aria-label="Run recording" className={`${PANEL} order-1 min-w-0 lg:order-2 lg:flex lg:min-h-0 lg:flex-col`}>
      <h3 className="shrink-0 font-semibold">Recording</h3>
      <div className="mt-3 lg:min-h-0 lg:flex-1"><RecordingVideo ref={video} data-asset-id={recordingAsset!} className="scroll-mt-[calc(var(--admin-header-height,6rem)+1rem)]" src={assetHref(recordingAsset!)} onLoadedMetadata={() => {
        if (video.current && pendingOffset.current !== null) {video.current.currentTime = pendingOffset.current; pendingOffset.current = null;}
      }} /></div>
    </section>}
    <section id="run-phase-test" tabIndex={-1} aria-label="Execution steps" className={`${PANEL} min-w-0 ${hasRecording ? "order-2 lg:order-1 lg:flex lg:min-h-0 lg:flex-col" : ""}`}><h3 className="shrink-0 font-semibold">Execution</h3>
      <label className="mt-3 block shrink-0 text-sm">Search steps<input type="search" className={`mt-1 block ${TESTING_FIELD}`} value={stepSearch} onChange={event => setStepSearch(event.target.value)} placeholder="Instruction, expected result or step ID" /></label>
      <div role="region" aria-label="Execution details" tabIndex={0} className={`mt-2 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 ${hasRecording ? "lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2" : ""}`}>
      {!visibleSteps.length && <p className="mt-3">No steps match your search.</p>}
      <ol role="list" className="mt-3 list-none space-y-2">{visibleSteps.map(({step, index, source}) => {
        const title = source?.instruction ?? step.id;
        return <li key={step.id} className={`flex gap-3 rounded-lg border p-3 ${selectedStep === step.id ? "border-[#3b7650] bg-[#edf6ef]" : "border-[#e0e4de]"}`}>
          <span aria-hidden="true" className="w-7 shrink-0 text-right">{index + 1}.</span>
          <div className="min-w-0 flex-1">
          {step.recordingLocation && uploadsComplete ? <button type="button" className="block w-full rounded-sm text-left text-sm hover:text-[#0969da] focus-visible:outline-2 focus-visible:outline-[#0969da]" aria-current={selectedStep === step.id ? "step" : undefined} onClick={() => seekStep(step.id, step.recordingLocation!)}><span className="font-medium">{title}</span> <StepStatus status={step.status} /> · {elapsedDuration(step.durationMs)}<span className="block text-sm">Watch this step · {recordingOffset(step.recordingLocation.startOffsetMs)}</span></button>
            : <p>{title} <StepStatus status={step.status} />{step.status !== "not-run" && ` · ${elapsedDuration(step.durationMs)}`}<span className="block text-sm text-[#68746d]">{step.status === "not-run" ? "Not executed" : "Recording location unavailable"}</span></p>}
          {source && <p className="mt-1 text-sm">Expected: {source.expected}</p>}
          {step.causedBy && <p className="mt-1 text-sm">Caused by: {step.causedBy}</p>}
          </div>
        </li>;
      })}</ol>
      {run.result.failures.filter(failure => failure.phase === "test").map((failure, index) => <p id={`run-failure-${failure.phase}-${index}`} tabIndex={-1} role="alert" className="mt-2 scroll-mt-24 whitespace-pre-wrap" key={index}>{failure.actionId}: {failure.message}</p>)}
      </div>
    </section>
    </div>
    <LifecyclePanel phase="teardown" actions={run.result.teardown.actions} status={run.result.teardown.ready ? "passed" : "failed"}
      durationMs={run.result.timing.teardownMs} failures={run.result.failures.filter(failure => failure.phase === "teardown")}
      unavailable={run.result.teardown.unavailableResources} />
    <section id="run-phase-evidence" tabIndex={-1} className={PANEL}><h3 className="font-semibold">Evidence</h3>
      {run.result.failures.filter(failure => failure.phase === "evidence").map((failure, index) => <p id={`run-failure-${failure.phase}-${index}`} tabIndex={-1} role="alert" className="mt-2 scroll-mt-24 whitespace-pre-wrap" key={index}>{failure.actionId}: {failure.message}</p>)}
      <ul className="mt-3 space-y-2">{run.assets.map(asset => <li key={asset.id}>{uploadsComplete ? <a className={TESTING_LINK} href={assetHref(asset.id)}>{asset.path}</a> : asset.path} · {asset.kind}</li>)}</ul>
      <p className="mt-4 text-xs">Source revision: <code>{run.definitionRevision}</code></p>
    </section>
  </div>;
}

type LifecycleAction = NonNullable<FrameworkRun["result"]["setup"]["actions"]>[number];
function LifecyclePanel({phase, actions, status, actionId, durationMs, failures, unavailable = []}: {
  phase: "setup" | "teardown";
  actions?: LifecycleAction[];
  status: "passed" | "failed" | "cancelled";
  actionId?: string;
  durationMs: number;
  failures: FrameworkRun["result"]["failures"];
  unavailable?: FrameworkRun["result"]["teardown"]["unavailableResources"];
}) {
  const title = phase === "setup" ? "Setup" : "Teardown";
  const stageLabels: Record<NonNullable<LifecycleAction["stage"]>, string> = {
    validation: "Validate inputs", "before-entry": "Before entry", entry: "Establish entry",
    "after-entry": "After entry", recording: phase === "setup" ? "Start recording" : "Finish recording",
    "teardown-actions": "Teardown actions", "resource-cleanup": "Resource cleanup",
  };
  // Preserve recorded order, including mixed ownership and repeated stage boundaries.
  const groups: Array<{stage: LifecycleAction["stage"]; start: number; actions: LifecycleAction[]}> = [];
  for (const [index, action] of (actions ?? []).entries()) {
    const previous = groups.at(-1);
    if (previous && previous.stage === action.stage) previous.actions.push(action);
    else groups.push({stage: action.stage, start: index, actions: [action]});
  }
  const lastFailure = (actions ?? []).reduce((last, action, index) => action.status === "failed"
    || failures.some(failure => failure.actionId === action.id) || status === "failed" && actionId === action.id ? index : last, -1);
  const actionList = (items: LifecycleAction[], start: number) => <ol start={start + 1} className="mt-3 space-y-2">{items.map((action, index) => <li key={action.id}
    className={`flex gap-3 rounded-lg border border-l-4 p-3 ${action.scope === "routine"
      ? "border-[#bbd4c2] border-l-[#3b7650] bg-[#f3f8f4]" : "border-[#d9dfe5] border-l-[#778493] bg-[#f7f8fa]"}`}>
    <span aria-hidden="true" className="w-7 shrink-0 text-right">{start + index + 1}.</span>
    <div className="min-w-0 flex-1"><p>{action.instruction} <StepStatus status={action.status} />
      {action.status !== "not-run" && ` · ${elapsedDuration(action.durationMs)}`}</p>
      <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-semibold ${action.scope === "routine"
        ? "bg-[#dcecdf] text-[#285538]" : "bg-[#e5e9ee] text-[#455160]"}`}>{action.scope === "routine" ? "Routine" : "Framework"}</span>
      <p className="mt-1 text-sm text-[#68746d]">Expected: {action.expected}</p>
      {action.startedAt && <p className="mt-1 text-sm">Started {new Date(action.startedAt).toLocaleTimeString()}
        {action.finishedAt && ` · Finished ${new Date(action.finishedAt).toLocaleTimeString()}`}</p>}
      {action.causedBy && <p className="mt-1 text-sm">Caused by: {action.causedBy}</p>}
    </div>
  </li>)}</ol>;
  return <section id={`run-phase-${phase}`} tabIndex={-1} aria-label={`${title} details`} className={PANEL}>
    <h3 className="font-semibold">{title} <StepStatus status={status} /> · {elapsedDuration(durationMs)}</h3>
    {actionId && <p className="mt-2 text-sm">Stopped at: {actionId}</p>}
    {actions === undefined ? <p className="mt-2 text-sm text-[#68746d]">{title} action details were not recorded for this run.</p>
      : !actions.length ? <p className="mt-2 text-sm text-[#68746d]">No {phase} actions recorded.</p>
      : groups.map(group => <details key={group.start} className="mt-4" open={group.start <= lastFailure} aria-label={`${title}: ${group.stage ? stageLabels[group.stage] : "Stage not recorded"}`}>
        <summary className="cursor-pointer text-sm font-semibold">{group.stage ? stageLabels[group.stage] : "Stage not recorded"} · {group.actions.length} {group.actions.length === 1 ? "action" : "actions"}</summary>
        {actionList(group.actions, group.start)}
      </details>)}
    {failures.map((failure, index) => <p id={`run-failure-${failure.phase}-${index}`} tabIndex={-1} role="alert" className="mt-2 scroll-mt-24 whitespace-pre-wrap" key={index}>{failure.actionId}: {failure.message}</p>)}
    {unavailable.map(resource => <p role="alert" className="mt-2 whitespace-pre-wrap" key={resource.resource}>{resource.resource}: {resource.cause}. Next action: {resource.nextAction}</p>)}
  </section>;
}

export function FrameworkRunsPage({scope, historySource}: {scope?: Record<string, string>; historySource?: HistoryOrigin}) {
  return scope ? <FilteredFrameworkRunsPage scope={scope}/> : <TestHistoryList initialOrigin={historySource}/>;
}
export const HISTORY_ORIGINS = [["pr", "Pull Requests"], ["branch", "Nightly"], ["manual", "Other"]] as const;
export type HistoryOrigin = typeof HISTORY_ORIGINS[number][0];
export function historyOrigin(entry: TestHistoryEntry): HistoryOrigin {
  if (entry.kind === "unavailable") return "manual";
  if (entry.kind === "run" && entry.rerun || entry.kind === "suite" && entry.trigger === "manual") return "manual";
  const channel = entry.kind === "suite" ? entry.channel : entry.build.channel;
  return channel === "pr" ? "pr" : channel === "dev" || channel === "staging" ? "branch" : "manual";
}
function TestHistoryList({initialOrigin = "pr"}: {initialOrigin?: HistoryOrigin}) {
  const [filters, setFilters] = useRoutineSearch();
  const [origin, setOrigin] = useState<HistoryOrigin>(initialOrigin);
  const tabId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const catalog = useSearchCatalog();
  const history = useInfiniteQuery({queryKey: ["test-history", true], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam, signal}) => api<TestHistoryPage>(testHistoryListPath(true, pageParam), {signal, timeoutMs: 30000}),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false, retryOnMount: false,
    refetchInterval: query => query.state.error ? false : 15000});
  const entries = history.data?.pages.flatMap(page => page.entries) ?? [];
  const routines = catalog.data?.routines ?? [];
  const originEntries = entries.filter(entry => entry.kind === "unavailable" || historyOrigin(entry) === origin);
  const filtered = originEntries.filter(entry => matchesHistorySearch(entry, routines, filters));
  const members = entries.flatMap<{routineId: string; platform: string}>(entry => entry.kind === "suite" ? entry.members ?? [] : entry.kind === "run" ? [entry] : []);
  const options = [...routines.map(searchableRoutine), ...members.map(member => runSearchMetadata(member, routines))];
  return <section className={PANEL}>
    <div role="tablist" aria-label="Dispatch source" className="mb-4 flex gap-1 overflow-x-auto border-b border-[#e0e4de]">
      {HISTORY_ORIGINS.map(([value, label], index) => <button key={value} ref={button => {tabs.current[index] = button;}}
        role="tab" id={`${tabId}-${value}`} aria-selected={origin === value} aria-controls={`${tabId}-history`} tabIndex={origin === value ? 0 : -1}
        className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${origin === value ? "border-[#111217] text-[#111217]" : "border-transparent text-[#747780] hover:text-[#14151b]"}`}
        onClick={() => setOrigin(value)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % HISTORY_ORIGINS.length : event.key === "ArrowLeft" ? (index + HISTORY_ORIGINS.length - 1) % HISTORY_ORIGINS.length : event.key === "Home" ? 0 : event.key === "End" ? HISTORY_ORIGINS.length - 1 : null;
          if (next !== null) {event.preventDefault(); setOrigin(HISTORY_ORIGINS[next][0]); tabs.current[next]?.focus();}
        }}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`${tabId}-history`} aria-labelledby={`${tabId}-${origin}`} tabIndex={0}>
    <RoutineSearch placeholder="Routine, PR, commit or tested build" filters={filters} onChange={setFilters} routines={options} countLabel={`Showing ${filtered.length} of ${originEntries.length} loaded entries`} />
    <details className="mt-2 text-xs text-[#747780]"><summary className="cursor-pointer">Search scope</summary><p className="mt-2">Tabs and filters apply to loaded history. Load more history to search older entries. Suites match when one member meets all filters.</p></details>
    {catalog.isPending && <LoadingIndicator label="Loading routine names and glasses requirements" className="mt-2 text-sm" />}
    {catalog.error && <p role="alert" className="mt-2 text-sm">Routine search metadata could not load: {catalog.error.message} <TestingButton onClick={() => catalog.refetch()}>Retry routine metadata</TestingButton></p>}
    {history.isPending && <LoadingIndicator label="Loading test history" className="mt-3" />}
    {history.error && <p role="alert" className="mt-3">{history.data ? "History could not refresh" : "Could not load test history"}: {history.error.message} <TestingButton onClick={() => history.refetch()}>Retry</TestingButton></p>}
    {history.data && !entries.length && <p className="mt-3">No test suites or routine runs yet.</p>}
    {history.data && !!entries.length && !filtered.length && <p className="mt-3">No loaded test history matches this tab and your filters.</p>}
    {!!filtered.length && <TestHistoryTable entries={filtered} routines={routines}/>}
    {history.hasNextPage && <TestingButton className="mt-4" busy={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>More history</TestingButton>}
    </div>
  </section>;
}
export function testHistoryListPath(includeReruns: boolean, cursor?: string) {
  const query = new URLSearchParams({limit: "25", includeReruns: String(includeReruns)});
  if (cursor) query.set("cursor", cursor);
  return `/api/admin/test-runs/history/list?${query}`;
}
function FilteredFrameworkRunsPage({scope}: {scope: Record<string, string>}) {
  const [filters, setFilters] = useRoutineSearch();
  const catalog = useSearchCatalog();
  const params = new URLSearchParams(scope);
  const query = useInfiniteQuery({queryKey: ["framework-runs", params.toString()], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam, signal}) => api<ScopedRunPage>(`/api/admin/routine-catalog/results?${params}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, {signal, timeoutMs: 30000}),
    getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 15000});
  if (query.isPending) return <LoadingIndicator label="Loading runs" />;
  if (query.error && !query.data) return <p role="alert">Could not load runs: {query.error.message}</p>;
  const routines = catalog.data?.routines ?? [];
  const runs = query.data.pages.flatMap(page => page.runs);
  const options = runs.map(run => runSearchMetadata(run, routines));
  const filtered = runs.filter(run => matchesHistorySearch({kind: "run", ...run}, routines, filters));
  return <section className={PANEL}><h2 className="text-xl font-semibold">Filtered routine runs</h2>
    <RoutineSearch placeholder="Routine, PR, commit or tested build" filters={filters} onChange={setFilters} routines={options} countLabel={`Showing ${filtered.length} of ${runs.length} loaded runs`} />
    <p className="mt-2 text-xs text-[#747780]">Searches loaded runs for this build.</p>
    {catalog.isPending && <LoadingIndicator label="Loading routine names and glasses requirements" className="mt-2 text-sm" />}
    {catalog.error && <p role="alert" className="mt-2 text-sm">Routine search metadata could not load: {catalog.error.message} <TestingButton onClick={() => catalog.refetch()}>Retry routine metadata</TestingButton></p>}
    {query.error && <p role="alert" className="mt-3">Runs could not refresh: {query.error.message}</p>}
    {!runs.length && <p className="mt-3">No routine runs match this build.</p>}
    {!!runs.length && !filtered.length && <p className="mt-3">No loaded routine runs match your filters for this build.</p>}
    {!!filtered.length && <TestHistoryTable entries={filtered.map(run => ({kind: "run" as const, ...run}))} routines={routines}/>}
    {query.hasNextPage && <TestingButton className="mt-4" busy={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>More runs</TestingButton>}
  </section>;
}
export function recordingOffset(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function matchesStepSearch(step: FrameworkRun["result"]["steps"][number], source: RoutineEnrollment["definition"]["steps"][number] | undefined, search: string) {
  return `${step.id} ${source?.instruction ?? ""} ${source?.expected ?? ""} ${step.status}`.toLowerCase().includes(search.trim().toLowerCase());
}
function StepStatus({status}: {status: FrameworkRun["result"]["steps"][number]["status"] | "cancelled"}) {
  return <HistoryStatus outcome={status}/>;
}
function definitionSourceHref(source: RoutineEnrollment["definition"]["source"]) {
  return `https://github.com/${source.repository}/blob/${source.revision}/${source.path.split("/").map(encodeURIComponent).join("/")}`;
}
function BuildIdentity({build, label = "Tested build"}: {build: {channel: string; headSha: string; repository?: string; release?: unknown; releaseIdentity?: unknown; producerUrl?: unknown}; label?: string}) {
  const href = build.repository && /^[\w-]+\/[\w.-]+$/.test(build.repository) && /^[a-f0-9]{40}$/.test(build.headSha) ? `https://github.com/${build.repository}/commit/${build.headSha}` : null;
  const producer = typeof build.producerUrl === "string" && /^https:\/\/github\.com\/Mentra-Community\//.test(build.producerUrl) ? build.producerUrl : null;
  const release = typeof build.releaseIdentity === "string" ? build.releaseIdentity : typeof build.release === "string" ? build.release : null;
  return <>{label}: {build.channel}{release && ` · ${release}`} · {href ? <a className={TESTING_LINK} href={href} target="_blank" rel="noreferrer"><code>{build.headSha.slice(0, 10)}</code></a> : <code>{build.headSha.slice(0, 10)}</code>}{producer && <> · <a className={TESTING_LINK} href={producer} target="_blank" rel="noreferrer">Build job</a></>}</>;
}
