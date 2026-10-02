import {useInfiniteQuery, useQuery} from "@tanstack/react-query";
import {api} from "../lib/api";
import {testRunAssetPath} from "../lib/test-run-links";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";
import type {CatalogExample, CatalogHistoryRun} from "../../../../packages/core/src/services/routine-catalog.service";

type CatalogRow = RoutineEnrollment & {example: CatalogExample | null};
type Detail = CatalogRow & {history: CatalogHistoryRun[]; nextCursor: string | null};
const PANEL = "rounded-2xl border border-[#e0e4de] bg-white p-5";
export function routineHref(id: string, platform: string) {
  return `/?routineCatalog=1&routine=${encodeURIComponent(id)}&platform=${encodeURIComponent(platform)}`;
}

export function RoutineCatalogPage({onResult}: {onResult: (runId: string) => void}) {
  const query = new URLSearchParams(window.location.search);
  const id = query.get("routine"), platform = query.get("platform");
  return id && platform ? <RoutineDetailPage id={id} platform={platform} onResult={onResult} /> : <RoutineCatalogList />;
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
    <p className="mt-2 text-sm">PR label <code>routine:{routine.routineId}</code></p>
  </article>;
}

function RoutineDetailPage({id, platform, onResult}: {id: string; platform: string; onResult: (runId: string) => void}) {
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
        src={testRunAssetPath(row.example.runId, row.example.recordingAssetId)} />
        <button className="mt-2 underline" onClick={() => onResult(row.example!.runId)}>Open passing run</button></div>
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
        <button className="underline" onClick={() => onResult(run.runId)}>{new Date(run.startedAt).toLocaleString()}</button>
        {" · "}{run.outcome}{!run.uploadsComplete && " · evidence pending"}</li>)}</ul>
      {detail.hasNextPage && <button className="mt-4 underline" disabled={detail.isFetchingNextPage} onClick={() => detail.fetchNextPage()}>More runs</button>}
    </section>
  </div>;
}
