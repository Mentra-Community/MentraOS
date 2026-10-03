import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";
import type {TestBuild, TestBuildSource} from "../../../../packages/core/src/types/test-build.types";
import {Button} from "../components/ui/button";
import {api} from "../lib/api";

export function NativeActivityPanel() {
  const query = useQuery({queryKey: ["framework-activity"], queryFn: () => api<{requests: {requestId: string; hostId: string; state: string; input: {routineId: string; laneId: string}}[]}>("/api/admin/test-runs/activity"), refetchInterval: 15000});
  return <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Request delivery</h2><p className="text-sm">Accepted means the host has received the request. Lane execution is owned by the host controller.</p>
    {query.error && <p role="alert">Could not refresh request delivery: {query.error.message}</p>}
    {query.data?.requests.map(row => <p key={row.requestId}>{row.input.routineId} · {row.input.laneId} · {row.hostId} · {row.state}</p>)}
    {query.data?.requests.length === 0 && <p>No pending requests.</p>}
  </section>;
}

export const buildSelectable = (build: TestBuild) => build.availability === "available" && !!build.archive;
export const buildKey = (build: TestBuild) => `${build.platform}-${build.source.channel}-${build.source.buildRunId}-${build.source.publicationAttempt}`;
export function TestBuildOption({build, checked, disabled, onSelect}: {build: TestBuild; checked: boolean; disabled: boolean; onSelect: () => void}) {
  const selectable = buildSelectable(build);
  return <label className={`flex gap-3 rounded-xl border p-3 ${selectable ? "bg-white" : "bg-gray-50 text-gray-500"}`}>
    <input type="radio" name="build" aria-label={build.title} checked={checked} disabled={disabled || !selectable} onChange={onSelect} />
    <span><strong>{build.title}</strong><span className="block text-sm">{build.release ? `${build.release} · ` : ""}{build.headSha.slice(0, 10)}</span>
      <span className="block text-sm">{selectable ? "Published · ready to select" : build.reason ?? "Artifact not published"}</span>
      <a className="text-sm underline" href={build.buildUrl} target="_blank" rel="noreferrer">View build in GitHub</a></span>
  </label>;
}
type Submission = {requestId: string; hostId: string; laneId: string; routineId: string; platform: "android" | "ios-on-mac"; source: TestBuildSource; archiveSha256: string};

/** The picker resolves a published artifact; the controller's request queue executes it. */
export function NativeDispatchPanel() {
  const routines = useQuery({queryKey: ["dispatch-routines"], queryFn: () => api<{routines: RoutineEnrollment[]}>("/api/admin/test-routines"), refetchInterval: 15000});
  const [routine, setRoutine] = useState("");
  const [channel, setChannel] = useState("dev");
  const [pr, setPr] = useState("");
  const [host, setHost] = useState("");
  const [lane, setLane] = useState("");
  const [inventory, setInventory] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [message, setMessage] = useState("");
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [sending, setSending] = useState(false);
  const definition = routines.data?.routines.find(row => `${row.routineId}/${row.platform}` === routine);
  const builds = useQuery({queryKey: ["picker-builds", inventory], enabled: !!inventory, queryFn: () => api<{builds: TestBuild[]}>(inventory!)});
  const selected = builds.data?.builds.find(build => buildKey(build) === selection);
  function findBuilds() {
    if (!definition) {setMessage("Select a routine."); return;}
    if (channel === "pr" && (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr)))) {setMessage("Enter a positive PR number."); return;}
    const params = new URLSearchParams({channel, platform: definition.platform});
    if (channel === "pr") params.set("pr", pr);
    setInventory(`/api/admin/test-builds?${params}`); setSelection(""); setMessage("");
  }
  function changed() {setInventory(null); setSelection(""); setMessage("");}
  async function submit() {
    setSending(true);
    try {
      if (!submission && (!definition || !selected || !buildSelectable(selected) || !host || !lane)) throw new Error("Select a published build and target lane.");
      const body = submission ?? {requestId: crypto.randomUUID(), hostId: host, laneId: lane,
        routineId: definition!.routineId, platform: definition!.platform, source: selected!.source, archiveSha256: selected!.archive!.sha256};
      setSubmission(body);
      const result = await api<{requestId: string; state: string}>("/api/admin/test-dispatches/picker", {method: "POST", body});
      setMessage(`${result.state === "queued" ? "Queued for the controller" : result.state} · ${result.requestId}`);
    } catch (error) {setMessage(error instanceof Error ? error.message : "Request failed. Retry the same request to check its receipt.");}
    finally {setSending(false);}
  }
  const locked = !!submission || sending;
  return <section className="rounded-xl border bg-white p-5 space-y-3"><h2 className="font-semibold">Run a routine</h2>
    <div className="flex flex-wrap gap-3"><label>Routine <select aria-label="Routine" value={routine} disabled={locked} onChange={event => {setRoutine(event.target.value); changed();}}><option value="">Select routine</option>{routines.data?.routines.map(row => <option key={`${row.routineId}/${row.platform}`} value={`${row.routineId}/${row.platform}`}>{row.definition.title} · {row.platform}</option>)}</select></label>
    <label>Build channel <select aria-label="Build channel" value={channel} disabled={locked} onChange={event => {setChannel(event.target.value); changed();}}><option value="dev">Dev</option><option value="staging">Staging</option><option value="pr">PR</option></select></label>
    {channel === "pr" && <label>PR number <input aria-label="PR number" value={pr} disabled={locked} onChange={event => {setPr(event.target.value); changed();}} /></label>}
    <Button disabled={locked || !definition} onClick={findBuilds}>Find builds</Button></div>
    {routines.error && <p role="alert">Could not load routines: {routines.error.message}</p>}
    {builds.isFetching && <p role="status">Finding published builds…</p>}
    {builds.error && <p role="alert">Could not find builds: {builds.error.message}</p>}
    {builds.data?.builds.map(build => <TestBuildOption key={buildKey(build)} build={build} checked={selection === buildKey(build)} disabled={locked} onSelect={() => setSelection(buildKey(build))} />)}
    {inventory && builds.data?.builds.length === 0 && <p>No builds found for this selection.</p>}
    <div className="flex gap-3"><label>Computer <input aria-label="Host ID" value={host} disabled={locked} onChange={event => setHost(event.target.value)} /></label>
    <label>Lane <input aria-label="Lane ID" value={lane} disabled={locked} onChange={event => setLane(event.target.value)} /></label></div>
    <Button disabled={sending || (!submission && (!selected || !host || !lane))} onClick={submit}>{submission ? "Retry same request" : "Run routine"}</Button>
    {submission && <Button disabled={sending} onClick={() => {setSubmission(null); setMessage("");}}>New request</Button>}
    <p role="status">{message}</p>
  </section>;
}
