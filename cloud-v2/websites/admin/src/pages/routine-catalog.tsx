import {useEffect, useRef, useState} from "react";
import {useInfiniteQuery, useQuery} from "@tanstack/react-query";
import type {FrameworkRun} from "../../../../packages/core/src/types/framework-run.types";
import {api} from "../lib/api";
import {testRunLocation} from "../lib/test-run-links";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";
import type {CatalogExample, CatalogHistoryRun} from "../../../../packages/core/src/services/routine-catalog.service";

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
  const result = useQuery({queryKey: ["framework-run", runId], queryFn: () =>
    api<{run: FrameworkRun; definition: RoutineEnrollment["definition"] | null; outcome: string; uploadsComplete: boolean; evidenceStatus: "complete" | "failed"}>(`/api/admin/routine-catalog/results/by-run/${encodeURIComponent(runId)}`),
    refetchInterval: query => query.state.data?.uploadsComplete === false ? 5000 : false});
  useEffect(() => {
    const step = result.data?.run.result.steps.find(item => item.id === stepId);
    if (step?.recordingLocation) {
      pendingOffset.current = step.recordingLocation.startOffsetMs / 1000;
      setSelectedAsset(step.recordingLocation.assetId);
      if (video.current?.readyState && video.current.dataset.assetId === step.recordingLocation.assetId) {
        video.current.currentTime = pendingOffset.current; pendingOffset.current = null;
      }
    } else {pendingOffset.current = null; setSelectedAsset(null);}
  }, [runId, stepId, result.data?.run]);
  if (result.isPending) return <p role="status">Loading run…</p>;
  if (result.error && !result.data) return <p role="alert">Could not load run: {result.error.message}</p>;
  const {run, definition, outcome, uploadsComplete, evidenceStatus} = result.data;
  const recordingAsset = selectedAsset ?? run.recordingAssetId;
  const seekStep = (location: NonNullable<FrameworkRun["result"]["steps"][number]["recordingLocation"]>) => {
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
  return <div className="space-y-5">
    <a className="underline" href={routineHref(run.routineId, run.platform)}>Back to routine</a>
    <section className={PANEL}><h2 className="text-xl font-semibold">{run.routineId}: {outcome}</h2>
      <p className="mt-2">Started {new Date(run.startedAt).toLocaleString()} · Finished {new Date(run.finishedAt).toLocaleString()}</p>
      <p className="mt-2">Computer: {run.hostId} · Lane: {run.laneId} · {run.platform}</p>
      <p className="mt-2">Setup {seconds(run.result.timing.setupMs)} · Test {seconds(run.result.timing.testMs)} · Teardown {seconds(run.result.timing.teardownMs)}</p>
      {evidenceStatus === "failed" && <p role="alert" className="mt-2">Evidence failed; the execution verdict is unchanged.</p>}
      {!uploadsComplete && <p role="status" className="mt-2">Evidence upload pending.</p>}
    </section>
    <div className={hasRecording ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" : "space-y-5"}>
    {hasRecording && <section aria-label="Run recording" className={`${PANEL} order-1 min-w-0 lg:order-2 lg:sticky lg:top-[calc(var(--admin-header-height,6rem)+1rem)]`}>
      <h3 className="font-semibold">Recording</h3>
      <video ref={video} data-asset-id={recordingAsset!} className="mt-3 max-h-[70dvh] w-full rounded-lg bg-black object-contain lg:max-h-[calc(100dvh-var(--admin-header-height,6rem)-8rem)]" controls preload="metadata" src={assetHref(recordingAsset!)} onLoadedMetadata={() => {
        if (video.current && pendingOffset.current !== null) {video.current.currentTime = pendingOffset.current; pendingOffset.current = null;}
      }} />
    </section>}
    <div className={`min-w-0 space-y-5 ${hasRecording ? "order-2 lg:order-1" : ""}`}>
    <section aria-label="Execution steps" className={PANEL}><h3 className="font-semibold">Execution</h3>
      <p className="mt-2">Setup: {run.result.setup.status}{run.result.setup.actionId && ` (${run.result.setup.actionId})`}</p>
      <ol role="list" className={`mt-3 list-none space-y-2 ${hasRecording ? "lg:max-h-[calc(100dvh-var(--admin-header-height,6rem)-10rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-2" : ""}`}>{run.result.steps.map((step, index) => {
        const source = definition?.steps.find(item => item.id === step.id);
        const title = source?.instruction ?? step.id;
        return <li key={step.id} className="flex gap-3 rounded-lg border border-[#e0e4de] p-3">
          <span aria-hidden="true" className="w-7 shrink-0 text-right">{index + 1}.</span>
          <div className="min-w-0 flex-1">
          {step.recordingLocation && uploadsComplete ? <button className="block w-full text-left" onClick={() => seekStep(step.recordingLocation!)}><span className="underline">{title}</span> · {step.status} · {seconds(step.durationMs)}<span className="block text-sm">Watch this step</span></button>
            : <p>{title} · {step.status}{step.status !== "not-run" && ` · ${seconds(step.durationMs)}`}<span className="block text-sm text-[#68746d]">{step.status === "not-run" ? "Not executed" : "Recording location unavailable"}</span></p>}
          {source && <p className="mt-1 text-sm">Expected: {source.expected}</p>}
          {step.causedBy && <p className="mt-1 text-sm">Caused by: {step.causedBy}</p>}
          </div>
        </li>;
      })}</ol>
      <p className="mt-3">Teardown: {run.result.teardown.ready ? "ready" : "failed"}</p>
      {run.result.teardown.errors.map((failure, index) => <p role="alert" className="mt-2 whitespace-pre-wrap" key={`cleanup-${index}`}>Cleanup / {failure.actionId}: {failure.message}</p>)}
      {run.result.teardown.unavailableResources.map(resource => <p role="alert" className="mt-2 whitespace-pre-wrap" key={resource.resource}>{resource.resource}: {resource.cause}. Next action: {resource.nextAction}</p>)}
      {run.result.failures.map((failure, index) => <p role="alert" className="mt-2 whitespace-pre-wrap" key={index}>{failure.phase} / {failure.actionId}: {failure.message}</p>)}
    </section>
    <section className={PANEL}><h3 className="font-semibold">Evidence</h3>
      <ul className="mt-3 space-y-2">{run.assets.map(asset => <li key={asset.id}>{uploadsComplete ? <a className="underline" href={assetHref(asset.id)}>{asset.path}</a> : asset.path} · {asset.kind}</li>)}</ul>
      <p className="mt-4 text-xs">Source revision: <code>{run.definitionRevision}</code></p>
    </section>
    </div>

    </div>
  </div>;
}

export function FrameworkRunsPage({scope}: {scope?: Record<string, string>}) {
 const params = new URLSearchParams(scope);

 const query = useQuery({queryKey: ["framework-runs", params.toString()], queryFn: () => api<{runs: {runId: string; requestId: string; hostId: string; routineId: string; platform: string; laneId: string; startedAt: string; finishedAt: string; outcome: string; evidenceStatus: string; uploadsComplete: boolean}[]}>(`/api/admin/routine-catalog/results?${params}`), refetchInterval: 15000});
 if (query.isPending) return <p role="status">Loading runs…</p>;
 if (query.error && !query.data) return <p role="alert">Could not load runs: {query.error.message}</p>;
 return <section className={PANEL}><h2 className="text-xl font-semibold">Routine runs</h2><ul className="mt-4 space-y-3">{query.data.runs.map(run => <li key={run.requestId}><a className="underline" href={frameworkRunHref(run.runId)}>{run.routineId} · {run.platform} · {new Date(run.startedAt).toLocaleString()}</a> · {run.outcome} · {((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} seconds · {run.hostId}/{run.laneId}{run.evidenceStatus === "failed" && " · evidence failed"}{!run.uploadsComplete && " · upload pending"}</li>)}</ul></section>;
}
