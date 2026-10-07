import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {routineIdentitySchema} from "../../../../packages/core/src/types/routine-definition.types";
import {routineDispatchSchema} from "../../../../packages/core/src/types/routine-dispatch.types";
import type {TestBuild, TestBuildSource} from "../../../../packages/core/src/types/test-build.types";
import {Button} from "../components/ui/button";
import {api} from "../lib/api";

type DeliveryRequest = Pick<import('../../../../packages/core/src/types/framework-request.types').FrameworkRequestDisplay,
  'requestId' | 'hostId' | 'state' | 'createdAt' | 'routineId' | 'laneId' | 'platform' | 'reason' | 'definitionRevision'>;
const deliveryStates: Record<string, {label: string; explanation: string}> = {
  preparing: {label: "Preparing routine source", explanation: "The request is saved while the test computer verifies the selected source. No test has started."},
  queued: {label: "Waiting for computer", explanation: "The request is queued. The test computer has not confirmed receipt yet."},
  accepted: {label: "Received by computer", explanation: "The computer received the request. Execution has not been reported yet."},
  running: {label: "Running", explanation: "The computer reports that this request is running. Its test result is still pending."},
};
const readableName = (value: string) => value.replace(/[-_]+/g, " ").replace(/^./, letter => letter.toUpperCase());
export function NativeActivityPanel() {
  const query = useQuery({queryKey: ["framework-activity"], queryFn: () => api<{requests: DeliveryRequest[]}>("/api/admin/test-runs/activity"), refetchInterval: 15000});
  return <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Request delivery</h2>
    <p className="mt-2 text-sm text-[#68746d]">Track requests from the queue to the test computer. These delivery updates are not test results. Refreshes every 15 seconds.</p>
    {query.isPending && <p role="status" className="mt-4">Loading request delivery…</p>}
    {query.error && <p role="alert" className="mt-4">Could not refresh request delivery: {query.error.message} <button className="underline" onClick={() => query.refetch()}>Retry</button></p>}
    <div className="mt-4 space-y-3">{query.data?.requests.map(row => {
      const status = deliveryStates[row.state] ?? {label: "Delivery status unavailable", explanation: "This request has an unrecognized delivery state. Check its request details."};
      return <article key={row.requestId} className="rounded-xl border border-[#e0e4de] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{readableName(row.routineId)}</h3>
          <span className="rounded-lg bg-blue-50 px-2 py-1 text-sm text-blue-800">{status.label}</span></div>
        <p className="mt-2 text-sm">{status.explanation}</p>
        {row.reason && <p className="mt-2 text-sm">{row.reason}</p>}
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {row.platform && <div><dt className="text-[#68746d]">Platform</dt><dd>{row.platform === "ios-on-mac" ? "Mac" : row.platform === "android" ? "Android" : readableName(row.platform)}</dd></div>}
          <div><dt className="text-[#68746d]">Computer</dt><dd>{readableName(row.hostId)}</dd></div>
          <div><dt className="text-[#68746d]">Test lane</dt><dd>{readableName(row.laneId)}</dd></div>
          {row.createdAt && <div><dt className="text-[#68746d]">Requested</dt><dd>{new Date(row.createdAt).toLocaleString()}</dd></div>}
        </dl>
        <details className="mt-3 text-xs text-[#68746d]"><summary className="cursor-pointer">Request details</summary>
          <dl className="mt-2 space-y-1 break-all"><div><dt>Request ID</dt><dd>{row.requestId}</dd></div><div><dt>Routine ID</dt><dd>{row.routineId}</dd></div>
            <div><dt>Computer ID</dt><dd>{row.hostId}</dd></div><div><dt>Lane ID</dt><dd>{row.laneId}</dd></div><div><dt>Delivery state</dt><dd>{row.state}</dd></div></dl>
        </details>
      </article>;
    })}</div>
    {query.data?.requests.length === 0 && <p className="mt-4 text-sm">No pending requests. New requests will appear here until they finish.</p>}
  </section>;
}

export const buildSelectable = (build: TestBuild) => build.availability === "available" && !!build.archive && !!build.receipt;
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
type Submission = {requestId: string; hostId: string; laneId: string; routineId: string; platform: "android" | "ios-on-mac"; routineRevision?: string; source: TestBuildSource; archiveSha256: string};

export function pickerRequest({requestId, hostId, laneId, routineId, platform, routineRevision, build}: {
  requestId: string; hostId: string; laneId: string; routineId: string; platform: "android" | "ios-on-mac"; routineRevision?: string; build: TestBuild;
}): Submission {
  if (!hostId || !laneId || !buildSelectable(build) || build.platform && build.platform !== platform)
    throw new Error("Select a published build and target lane.");
  if (routineRevision && !/^[a-f0-9]{40}$/.test(routineRevision)) throw new Error("Enter a full 40-character routine commit SHA or leave it blank for latest main.");
  const selection = routineDispatchSchema.parse({requestId, routineId, platform, source: build.source,
    ...(routineRevision ? {routineRevision} : {})});
  return {...selection, hostId, laneId, archiveSha256: build.archive!.sha256};
}

/** The picker resolves a published artifact; the controller's request queue executes it. */
export function NativeDispatchPanel() {
  const [routine, setRoutine] = useState("");
  const [platform, setPlatform] = useState<"android" | "ios-on-mac">("android");
  const [routineRevision, setRoutineRevision] = useState("");
  const routines = useQuery({queryKey: ["dispatch-routines", routineRevision], enabled: !routineRevision || /^[a-f0-9]{40}$/.test(routineRevision),
    queryFn: () => api<{routineRevision: string; routines: {routineId: string}[]}>(`/api/admin/test-routines${routineRevision ? `?revision=${routineRevision}` : ""}`), refetchInterval: 15000});
  const [channel, setChannel] = useState("dev");
  const [pr, setPr] = useState("");
  const [host, setHost] = useState("");
  const [lane, setLane] = useState("");
  const [inventory, setInventory] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [message, setMessage] = useState("");
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [sending, setSending] = useState(false);

  const builds = useQuery({queryKey: ["picker-builds", inventory], enabled: !!inventory, queryFn: () => api<{builds: TestBuild[]}>(inventory!)});
  const selected = builds.data?.builds.find(build => buildKey(build) === selection);
  function findBuilds() {
    if (!routineIdentitySchema.safeParse(routine).success) {setMessage("Select a routine."); return;}
    if (channel === "pr" && (!/^[1-9]\d*$/.test(pr) || !Number.isSafeInteger(Number(pr)))) {setMessage("Enter a positive PR number."); return;}
    const params = new URLSearchParams({channel, platform});
    if (channel === "pr") params.set("pr", pr);
    setInventory(`/api/admin/test-builds?${params}`); setSelection(""); setMessage("");
  }
  function changed() {setInventory(null); setSelection(""); setMessage("");}
  async function submit() {
    setSending(true);
    try {
      if (!submission && (!routine || !selected || !buildSelectable(selected) || !host || !lane)) throw new Error("Select a published build and target lane.");
      const body = submission ?? pickerRequest({requestId: crypto.randomUUID(), hostId: host, laneId: lane,
        routineId: routine, platform, routineRevision, build: selected!});
      setSubmission(body);
      const result = await api<{requestId: string; state: string}>("/api/admin/test-dispatches/picker", {method: "POST", body});
      setMessage(`${result.state === "preparing" ? "Request saved; preparing routine source" : result.state === "queued" ? "Queued for the controller" : result.state} · ${result.requestId}`);
    } catch (error) {setMessage(error instanceof Error ? error.message : "Request failed. Retry the same request to check its receipt.");}
    finally {setSending(false);}
  }
  const locked = !!submission || sending;
  return <section className="rounded-xl border bg-white p-5 space-y-3"><h2 className="font-semibold">Run a routine</h2>
    <div className="flex flex-wrap gap-3"><label>Routine <select aria-label="Routine" value={routine} disabled={locked} onChange={event => {setRoutine(event.target.value); changed();}}><option value="">Select routine</option>{routines.data?.routines.map(row => <option key={row.routineId} value={row.routineId}>{row.routineId}</option>)}</select></label>
    <label>Platform <select aria-label="Platform" value={platform} disabled={locked} onChange={event => {setPlatform(event.target.value as "android" | "ios-on-mac"); changed();}}><option value="android">Android</option><option value="ios-on-mac">Mac</option></select></label>
    <label>Build channel <select aria-label="Build channel" value={channel} disabled={locked} onChange={event => {setChannel(event.target.value); changed();}}><option value="dev">Dev</option><option value="staging">Staging</option><option value="pr">PR</option></select></label>
    {channel === "pr" && <label>PR number <input aria-label="PR number" value={pr} disabled={locked} onChange={event => {setPr(event.target.value); changed();}} /></label>}
    <Button disabled={locked || !routine} onClick={findBuilds}>Find builds</Button></div>
    <p className="text-sm text-[#68746d]">The request uses latest Harness main when submitted. The test computer checks platform compatibility before starting.</p>
    <label>Routine revision (optional) <input aria-label="Routine revision" placeholder="Latest main" value={routineRevision} disabled={locked} onChange={event => setRoutineRevision(event.target.value.trim())} /></label>
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
