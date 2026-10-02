import {useInfiniteQuery, useQuery} from "@tanstack/react-query";
import type {FrameworkRun} from "../../../../packages/core/src/types/framework-run.types";
import {api} from "../lib/api";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";
import type {CatalogExample, CatalogHistoryRun} from "../../../../packages/core/src/services/routine-catalog.service";

type CatalogRow = RoutineEnrollment & {example: CatalogExample | null};
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
    queryFn: () => api<{routines: CatalogRow[]}>("/api/admin/routine-catalog")});
  if (catalog.isPending) return <p role="status">Loading routines…</p>;
  if (catalog.error) return <p role="alert">Could not load routines: {catalog.error.message}</p>;
  return <div className="space-y-5">
    <section className={PANEL}><h2 className="text-lg font-semibold">Routine catalog</h2>
      <p className="mt-2">Current routines, their requirements and latest complete passing recordings.</p></section>
    {!catalog.data.routines.length && <p>No routines have been enrolled on the new framework yet.</p>}
    <div className="grid gap-5 lg:grid-cols-2">{catalog.data.routines.map(row => <RoutineCatalogCard key={`${row.routineId}/${row.platform}`} routine={row} />)}</div>
  </div>;
}

export function RoutineCatalogCard({routine}: {routine: CatalogRow}) {
  return <article className={PANEL}>
    <p className="text-sm text-[#68746d]">{routine.platform === "android" ? "Android" : "iOS on Mac"}</p>
    <h3 className="mt-2 text-lg font-semibold"><a className="underline" href={routineHref(routine.routineId, routine.platform)}>{routine.definition.title}</a></h3>
    <p className="mt-2">{routine.definition.purpose}</p>
    <p className="mt-4">{routine.example ? "Complete passing example available" : "Awaiting a complete pass for this revision"}</p>
    <p className="mt-2 text-sm">Dispatch availability will appear after controller integration.</p>
  </article>;
}

function RoutineDetailPage({id, platform}: {id: string; platform: string}) {
  const detail = useInfiniteQuery({queryKey: ["routine-detail", id, platform], initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) => api<Detail>(`/api/admin/routine-catalog/${encodeURIComponent(id)}/${encodeURIComponent(platform)}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: page => page.nextCursor ?? undefined});
  if (detail.isPending) return <p role="status">Loading routine…</p>;
  if (detail.error) return <p role="alert">Could not load routine: {detail.error.message}</p>;
  const row = detail.data.pages[0]!, definition = row.definition;
  return <div className="space-y-5">
    <a href="/?routineCatalog=1" className="underline">All routines</a>
    <section className={PANEL}><h2 className="text-xl font-semibold">{definition.title}</h2><p className="mt-2">{definition.purpose}</p>
      {row.example ? <div className="mt-4"><video className="w-full rounded-lg" controls preload="metadata"
        src={`/api/admin/routine-catalog/results/by-request/${encodeURIComponent(row.example.runId)}/assets/${encodeURIComponent(row.example.recordingAssetId)}`} />
        <a className="mt-2 block underline" href={frameworkRunHref(row.example.runId)}>Open passing run</a></div>
        : <p className="mt-4">Awaiting a complete passing recording for this revision.</p>}
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
  return `/?routineCatalog=1&frameworkRun=${encodeURIComponent(runId)}`;
}

function FrameworkRunPage({runId}: {runId: string}) {
  const result = useQuery({queryKey: ["framework-run", runId], queryFn: () =>
    api<{run: FrameworkRun; outcome: string; uploadsComplete: boolean; evidenceStatus: "complete" | "failed"}>(`/api/admin/routine-catalog/results/by-request/${encodeURIComponent(runId)}`)});
  if (result.isPending) return <p role="status">Loading run…</p>;
  if (result.error) return <p role="alert">Could not load run: {result.error.message}</p>;
  const {run, outcome, uploadsComplete, evidenceStatus} = result.data;
  const assetHref = (id: string) => `/api/admin/routine-catalog/results/by-request/${encodeURIComponent(runId)}/assets/${encodeURIComponent(id)}`;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} seconds`;
  return <div className="space-y-5">
    <a className="underline" href={routineHref(run.routineId, run.platform)}>Back to routine</a>
    <section className={PANEL}><h2 className="text-xl font-semibold">{run.routineId}: {outcome}</h2>
      <p className="mt-2">Started {new Date(run.startedAt).toLocaleString()} · Finished {new Date(run.finishedAt).toLocaleString()}</p>
      <p className="mt-2">Lane: {run.laneId} · {run.platform}</p>
      <p className="mt-2">Setup {seconds(run.result.timing.setupMs)} · Test {seconds(run.result.timing.testMs)} · Teardown {seconds(run.result.timing.teardownMs)}</p>
      {evidenceStatus === "failed" && <p role="alert" className="mt-2">Evidence failed; the execution verdict is unchanged.</p>}
      {!uploadsComplete && <p role="status" className="mt-2">Evidence upload pending.</p>}
      {run.recordingAssetId && uploadsComplete && <video className="mt-4 w-full rounded-lg" controls preload="metadata" src={assetHref(run.recordingAssetId)} />}
    </section>
    <section className={PANEL}><h3 className="font-semibold">Execution</h3>
      <p className="mt-2">Setup: {run.result.setup.status}{run.result.setup.actionId && ` (${run.result.setup.actionId})`}</p>
      <ol className="mt-3 list-decimal space-y-2 pl-5">{run.result.steps.map(step => <li key={step.id}>{step.id}: {step.status} · {seconds(step.durationMs)}{step.causedBy && ` · caused by ${step.causedBy}`}</li>)}</ol>
      <p className="mt-3">Teardown: {run.result.teardown.ready ? "ready" : "failed"}</p>
      {run.result.failures.map((failure, index) => <p role="alert" className="mt-2 whitespace-pre-wrap" key={index}>{failure.phase} / {failure.actionId}: {failure.message}</p>)}
    </section>
    <section className={PANEL}><h3 className="font-semibold">Evidence</h3>
      <ul className="mt-3 space-y-2">{run.assets.map(asset => <li key={asset.id}>{uploadsComplete ? <a className="underline" href={assetHref(asset.id)}>{asset.path}</a> : asset.path} · {asset.kind}</li>)}</ul>
      <p className="mt-4 text-xs">Source revision: <code>{run.definitionRevision}</code></p>
    </section>
  </div>;
}

export function FrameworkRunsPage() {
 const query = useQuery({queryKey: ["framework-runs"], queryFn: () => api<{runs: {requestId: string; routineId: string; platform: string; startedAt: string; outcome: string; evidenceStatus: string; uploadsComplete: boolean}[]}>("/api/admin/routine-catalog/results"), refetchInterval: 15000});
 if (query.isPending) return <p role="status">Loading runs…</p>;
 if (query.error) return <p role="alert">Could not load runs: {query.error.message}</p>;
 return <section className={PANEL}><h2 className="text-xl font-semibold">Routine runs</h2><ul className="mt-4 space-y-3">{query.data.runs.map(run => <li key={run.requestId}><a className="underline" href={frameworkRunHref(run.requestId)}>{run.routineId} · {run.platform} · {new Date(run.startedAt).toLocaleString()}</a> · {run.outcome}{run.evidenceStatus === "failed" && " · evidence failed"}{!run.uploadsComplete && " · upload pending"}</li>)}</ul></section>;
}
