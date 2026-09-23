import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api, ApiError } from "../lib/api";
import type { TestBuild, TestDispatchInput, TestDispatchReceipt, TestDispatchView, TestRoutineId } from "../../../../packages/core/src/types/test-dispatch.types";

const SELECT = "h-9 rounded-lg border border-[#dfe3dc] bg-white px-3 text-sm";
export function testBuildInventoryPath(channel: string, pr: string) {
  if (!["pr", "dev", "staging"].includes(channel)) throw new Error("Choose a build channel.");
  const query = new URLSearchParams({ channel });
  if (channel === "pr") {
    if (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr))) throw new Error("Enter a positive PR number.");
    query.set("pr", pr);
  }
  return `/api/admin/test-builds?${query}`;
}
const buildKey = (build: TestBuild) => `${build.source.channel}-${build.source.buildRunId}-${build.source.publicationAttempt}`;

export function TestDispatchPanel({ onResult }: { onResult: (runId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("pr");
  const [pr, setPr] = useState("");
  const [inventoryPath, setInventoryPath] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [routineId, setRoutineId] = useState<TestRoutineId>("no-glasses");
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [submittedInput, setSubmittedInput] = useState<TestDispatchInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const builds = useQuery({ queryKey: ["admin-test-builds", inventoryPath], enabled: open && !!inventoryPath,
    queryFn: () => api<{ builds: TestBuild[] }>(inventoryPath!) });
  const routines = useQuery({ queryKey: ["admin-test-routines"], enabled: open,
    queryFn: () => api<{ routines: { id: TestRoutineId; name: string; description: string }[] }>("/api/admin/test-routines") });
  const recent = useQuery({ queryKey: ["admin-test-dispatches"], enabled: open,
    queryFn: () => api<{ dispatches: TestDispatchReceipt[] }>("/api/admin/test-dispatches") });
  const progress = useQuery({ queryKey: ["admin-test-dispatch", dispatchId], enabled: open && !!dispatchId && !submitting,
    queryFn: () => api<TestDispatchView>(`/api/admin/test-dispatches/${dispatchId}`), retry: false,
    refetchInterval: query => query.state.data && ["finished", "unavailable", "failed", "recovery-required"].includes(query.state.data.state) ? false : 5000 });
  const selected = builds.data?.builds.find(build => buildKey(build) === selection);
  const compatibility = selected?.routines.find(routine => routine.id === routineId);

  async function send(input: TestDispatchInput) {
    if (submitting) return;
    setDispatchId(input.idempotencyKey);
    setSubmittedInput(input);
    setSubmitting(true);
    setError(null);
    try {
      await api<TestDispatchView>("/api/admin/test-dispatches", { method: "POST", body: input });
      await recent.refetch();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to submit this routine.");
      // An uncertain response may already own a send. Retrying the exact saved
      // input/id is idempotent; allocating a replacement ID is not.
      if (failure instanceof ApiError && failure.status === 400) {
        setDispatchId(null); setSubmittedInput(null);
      }
    } finally { setSubmitting(false); }
  }
  function submit() {
    if (!selected?.archive || !compatibility?.available || submitting || dispatchId) return;
    void send({ source: selected.source, routineId, archiveSha256: selected.archive.sha256, idempotencyKey: crypto.randomUUID() });
  }
  function clearSelection() { setInventoryPath(null); setSelection(""); setError(null); }
  return (
    <section className="border-b border-[#eceeeb] p-5" aria-label="Run a routine">
      <div className="flex items-center justify-between gap-4">
        <div><h3 className="font-semibold">Run a routine</h3><p className="mt-1 text-sm text-[#68746d]">Choose an existing PR, dev or staging build. PR labels are optional.</p></div>
        <Button variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide controls" : "Run routine"}</Button>
      </div>
      {open ? <div className="mt-4 space-y-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
          event.preventDefault();
          try {
            const path = testBuildInventoryPath(channel, pr.trim());
            if (path === inventoryPath) void builds.refetch();
            setInventoryPath(path); setSelection(""); setError(null);
          } catch (failure) { setError((failure as Error).message); }
        }}>
          <label className="grid gap-1 text-xs font-medium">Build channel<select aria-label="Build channel" className={SELECT} value={channel} disabled={!!dispatchId} onChange={event => { setChannel(event.target.value); clearSelection(); }}>
            <option value="pr">Pull request</option><option value="dev">Dev</option><option value="staging">Staging</option>
          </select></label>
          {channel === "pr" ? <label className="grid gap-1 text-xs font-medium">PR number<Input aria-label="PR number to test" inputMode="numeric" value={pr} disabled={!!dispatchId} onChange={event => { setPr(event.target.value); clearSelection(); }} className="w-32" /></label> : null}
          <Button type="submit" variant="outline" disabled={builds.isFetching || !!dispatchId}>{builds.isFetching ? "Checking builds…" : "Find builds"}</Button>
        </form>
        {error || builds.error || routines.error ? <p role="alert" className="text-sm text-[#a64235]">{error ?? builds.error?.message ?? routines.error?.message}</p> : null}
        {builds.data ? <div className="space-y-2">
          {builds.data.builds.length ? builds.data.builds.map(build => <label key={buildKey(build)} className="flex items-start gap-3 rounded-xl border border-[#e0e4de] p-3 text-sm">
            <input type="radio" name="test-build" aria-label={`${build.title}, publication ${build.source.publicationAttempt}`} disabled={build.availability !== "available" || !!dispatchId}
              checked={selection === buildKey(build)} onChange={() => setSelection(buildKey(build))} />
            <span className="min-w-0"><span className="font-medium">{build.title}</span><span className="mt-1 block text-xs text-[#68746d]">
              {build.release ? `${build.release} · ` : ""}{build.headSha.slice(0, 12)} · run {build.source.buildRunId} / publication {build.source.publicationAttempt}
            </span><span className="mt-1 block">{build.availability === "available" ? "Mac artifact published; the request workflow completes validation" : build.reason ?? "Artifact unavailable"}</span>
              {build.archive ? <span className="mt-1 block break-all font-mono text-[10px]">SHA256 {build.archive.sha256}</span> : null}
              <a href={build.buildUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-[#087d50] underline">View build in GitHub</a>
            </span>
          </label>) : <p className="text-sm text-[#68746d]">No matching build runs were found.</p>}
          <div className="flex flex-wrap items-end gap-3 pt-2">
            <label className="grid gap-1 text-xs font-medium">Routine<select aria-label="Routine to run" className={SELECT} value={routineId} disabled={!!dispatchId} onChange={event => setRoutineId(event.target.value as TestRoutineId)}>
              {routines.data?.routines.map(routine => <option key={routine.id} value={routine.id}>{routine.name}</option>)}
            </select></label>
            <Button disabled={!compatibility?.available || submitting || !!dispatchId} onClick={submit}>{submitting ? "Submitting…" : "Request routine"}</Button>
          </div>
          {compatibility?.reason ? <p role="status" className="text-sm text-[#68746d]">{compatibility.reason}</p> : null}
        </div> : null}
        {dispatchId ? <div className="rounded-xl bg-[#f5f7f4] p-4">
          {progress.data ? <TestDispatchStatus dispatch={progress.data} onResult={onResult} /> : <p role="status">{submitting ? "Submitting the request…" : "Checking the saved request…"}</p>}
          {progress.error ? <p role="alert" className="mt-2 text-sm text-[#a64235]">{progress.error.message}</p> : null}
          <p className="mt-2 break-all font-mono text-[10px]">Submission {dispatchId}</p>
          <Button variant="ghost" disabled={submitting || progress.isFetching} onClick={() => progress.refetch()}>Refresh status</Button>
          {submittedInput && progress.error ? <Button variant="outline" disabled={submitting || progress.isFetching} onClick={() => void send(submittedInput)}>Retry saved request</Button> : null}
          {progress.data && ["finished", "unavailable", "failed"].includes(progress.data.state) ? <Button variant="outline" onClick={() => { setDispatchId(null); setSubmittedInput(null); clearSelection(); }}>New request</Button> : null}
        </div> : null}
        {recent.data?.dispatches.length ? <details><summary className="cursor-pointer text-sm font-medium">Recent routine requests</summary><ul className="mt-2 space-y-1">
          {recent.data.dispatches.map(item => <li key={item.dispatchId}><button disabled={submitting} className="text-left text-sm text-[#087d50] underline" onClick={() => { setDispatchId(item.dispatchId); setSubmittedInput(item.input); setError(null); }}>
            {item.input.routineId} · {item.input.source.channel === "pr" ? `PR #${item.input.source.prNumber}` : item.input.source.channel} · {new Date(item.createdAt).toLocaleString()}
          </button></li>)}
        </ul></details> : null}
      </div> : null}
    </section>
  );
}

export function TestDispatchStatus({ dispatch, onResult }: { dispatch: TestDispatchView; onResult: (id: string) => void }) {
  return <div><p className="font-semibold">{dispatch.state.replaceAll("-", " ")}</p><p className="mt-1 text-sm">{dispatch.message}</p>
    {dispatch.result ? <div className="mt-3 text-sm"><p>Test result: <strong>{dispatch.result.outcome}</strong></p>
      <p>{Object.entries(dispatch.result.outcomes).map(([name, value]) => `${name}: ${value}`).join(" · ")}</p>
      <Button className="mt-2" onClick={() => onResult(dispatch.result!.runId)}>View recording and evidence</Button></div> : null}
    <div className="mt-2 flex flex-wrap gap-3 text-sm text-[#087d50]">
      {dispatch.requestUrl ? <a href={dispatch.requestUrl} target="_blank" rel="noreferrer" className="underline">Request workflow</a> : null}
      {dispatch.workerUrl ? <a href={dispatch.workerUrl} target="_blank" rel="noreferrer" className="underline">Worker job</a> : null}
    </div>
  </div>;
}
