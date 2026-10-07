import {Ban, CheckCircle2, Clock3, FileText, Layers, Loader2, RotateCcw, XCircle} from "lucide-react";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";
import type {TestHistoryEntry} from "../../../../packages/core/src/types/test-history.types";
import {laneHistoryHref} from "../lib/lane-links";
import {elapsedDuration, runDuration} from "../lib/run-duration";
import {testRunLocation} from "../lib/test-run-links";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "./ui/table";

const LINK = "rounded-sm text-[#0969da] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0969da]";
const MUTED = "mt-1 text-xs text-[#656d76]";
const SUITE_ROW = "bg-[#f6f8fa] hover:bg-[#eaeef2]";
const readable = (value: string) => value.replace(/[-_]+/g, " ");
const suiteHref = (id: string) => `/?testSuite=${encodeURIComponent(id)}`;
const runHref = (id: string) => testRunLocation("https://admin.mentraglass.com/", {runID: id});

function StartedAt({value}: {value: string}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-[#656d76]">Unknown</span>;
  return <time dateTime={value} title={date.toLocaleString(undefined, {dateStyle: "full", timeStyle: "long"})} className="whitespace-nowrap tabular-nums">
    <span>{date.toLocaleDateString(undefined, {month: "short", day: "numeric"})}</span>
    <span className={`block ${MUTED}`}>{date.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", second: "2-digit"})}</span>
  </time>;
}

export function HistoryStatus({outcome}: {outcome: string}) {
  const passed = outcome === "pass" || outcome === "passed";
  const failed = outcome === "failed" || outcome.endsWith("-failed");
  const running = ["running", "in-progress"].includes(outcome);
  const aborted = ["cancelled", "aborted", "not-run"].includes(outcome);
  const label = passed ? "Passed" : running ? "In progress" : outcome === "not-run" ? "Not run" : readable(outcome).replace(/^./, character => character.toUpperCase());
  const Icon = passed ? CheckCircle2 : failed ? XCircle : running ? Loader2 : aborted ? Ban : Clock3;
  const tone = passed ? "border-[#aceebb] bg-[#dafbe1] text-[#1a7f37]" : failed ? "border-[#ffcecb] bg-[#ffebe9] text-[#cf222e]" : "border-[#d0d7de] bg-[#f6f8fa] text-[#656d76]";
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${tone}`}>
    <Icon aria-hidden="true" className={`size-3.5 ${running ? "animate-spin" : ""}`}/>{label}
  </span>;
}

/** A qualified pass requires complete evidence; execution failures keep their own verdict. */
export function runDisplayStatus(outcome: string, evidenceStatus: string, uploadsComplete: boolean) {
  const passed = outcome === "pass" || outcome === "passed";
  return passed && evidenceStatus === "failed" ? "evidence-failed"
    : passed && (evidenceStatus !== "complete" || !uploadsComplete) ? "evidence pending" : outcome;
}

function HistoryBuild({build}: {build: {channel?: string; repository?: string; headSha: string; release?: string; producerUrl?: string}}) {
  const commit = build.repository && /^[\w-]+\/[\w.-]+$/.test(build.repository) && /^[a-f0-9]{40}$/.test(build.headSha)
    ? `https://github.com/${build.repository}/commit/${build.headSha}` : null;
  const producer = build.producerUrl && /^https:\/\/github\.com\/Mentra-Community\//.test(build.producerUrl) ? build.producerUrl : null;
  const href = producer ?? commit;
  const name = build.release ?? build.headSha.slice(0, 10);
  return <div className="whitespace-nowrap" title={`Commit ${build.headSha}`}>
    {href ? <a className={LINK} href={href} target="_blank" rel="noreferrer">{name}</a> : <span>{name}</span>}
    {build.channel && <div className={MUTED}>{build.channel}</div>}
  </div>;
}

function HistoryLanes({lanes}: {lanes: {hostId: string; laneId: string}[]}) {
  if (!lanes.length) return <span className="text-[#656d76]">—</span>;
  return <div className="flex flex-wrap gap-1.5">{lanes.map(lane => <a key={`${lane.hostId}/${lane.laneId}`} href={laneHistoryHref(lane.hostId, lane.laneId)}
    title={`${lane.hostId} / ${lane.laneId}`} className="rounded-md border border-[#d0d7de] bg-[#f6f8fa] px-2 py-0.5 text-xs text-[#57606a] hover:bg-[#eaeef2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0969da]">{readable(lane.laneId)}</a>)}</div>;
}

function HistoryRow({entry, routines, now}: {entry: TestHistoryEntry; routines: RoutineEnrollment[]; now: number}) {
  if (entry.kind === "unavailable") {
    const suite = entry.sourceKind === "suite";
    const KindIcon = suite ? Layers : FileText;
    return <TableRow className={suite ? SUITE_ROW : undefined}>
      <TableCell><StartedAt value={entry.startedAt}/></TableCell>
      <TableCell><div className="flex items-start gap-2"><KindIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#656d76]"/><div><a className={LINK} href={suite ? suiteHref(entry.id) : runHref(entry.id)}>{suite ? "Test suite" : "Routine run"}</a><p role="alert" className={MUTED}>{entry.message}</p></div></div></TableCell>
      <TableCell colSpan={3} className="text-[#656d76]">—</TableCell><TableCell><HistoryStatus outcome="unavailable"/></TableCell>
    </TableRow>;
  }
  const suite = entry.kind === "suite";
  const KindIcon = suite ? Layers : FileText;
  const title = suite ? `${entry.channel[0].toUpperCase()}${entry.channel.slice(1)} ${entry.trigger} suite`
    : routines.find(routine => routine.routineId === entry.routineId && routine.platform === entry.platform)?.definition.title ?? readable(entry.routineId);
  const duration = entry.finishedAt ? runDuration(entry.startedAt, entry.finishedAt) : elapsedDuration(now - Date.parse(entry.startedAt));
  const lanes = suite ? entry.lanes ?? [] : [{hostId: entry.hostId, laneId: entry.laneId}];
  const outcome = suite && entry.outcome === "failed" && entry.failedCount === 0 ? "incomplete"
    : suite ? entry.outcome : runDisplayStatus(entry.outcome, entry.evidenceStatus, entry.uploadsComplete);
  return <TableRow className={suite ? SUITE_ROW : undefined}>
    <TableCell><StartedAt value={entry.startedAt}/></TableCell>
    <TableCell className="min-w-56 max-w-96">
      <div className="flex items-start gap-2"><KindIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#656d76]"/><div className="min-w-0">
        <a className={LINK} href={suite ? suiteHref(entry.suiteId) : runHref(entry.runId)}><span className="sr-only">{suite ? "Test suite: " : "Routine run: "}</span>{title}</a>
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${MUTED}`}>
          <span>{suite ? `${entry.expectedCount} routines` : entry.platform === "ios-on-mac" ? "iOS on Mac" : entry.platform === "android" ? "Android" : entry.platform}</span>
          {suite && entry.rerunCount > 0 && <a className="inline-flex items-center gap-1 rounded-md border border-[#d0d7de] px-1.5 py-0.5 hover:text-[#0969da]" href={suiteHref(entry.suiteId)} title={`${entry.rerunCount} accepted rerun jobs`}><RotateCcw className="size-3" aria-hidden="true"/>{entry.rerunCount} rerun{entry.rerunCount === 1 ? "" : "s"}</a>}
          {!suite && entry.rerun && <a className={LINK} href={`/?testRerun=${encodeURIComponent(entry.rerun.rerunId)}`}>Rerun</a>}
        </div>
      </div>
      </div>
    </TableCell>
    <TableCell className="whitespace-nowrap tabular-nums" title={entry.finishedAt ? `Finished ${new Date(entry.finishedAt).toLocaleString()}` : "Elapsed time"}>{duration ?? "—"}</TableCell>
    <TableCell><HistoryLanes lanes={lanes}/></TableCell>
    <TableCell><HistoryBuild build={suite ? {...entry.build, channel: entry.channel} : entry.build}/></TableCell>
    <TableCell className="min-w-40">
      <HistoryStatus outcome={outcome}/>
      {suite ? <p className={MUTED}>{entry.failedCount}/{entry.expectedCount - (entry.skipped ?? 0)} failed{entry.skipped ? `, ${entry.skipped} skipped` : ""}</p>
        : <>{entry.evidenceStatus === "failed" && outcome !== "evidence-failed" && <p className={`${MUTED} text-[#cf222e]`}>Evidence failed</p>}
          {entry.evidenceStatus !== "failed" && !entry.uploadsComplete && <p className={MUTED}>Evidence upload pending</p>}</>}
    </TableCell>
  </TableRow>;
}

export function TestHistoryTable({entries, routines, now = Date.now()}: {entries: TestHistoryEntry[]; routines: RoutineEnrollment[]; now?: number}) {
  return <div className="mt-4 overflow-hidden rounded-lg border border-[#d0d7de]">
    <Table aria-label="Test history" className="text-[#24292f]">
      <TableHeader className="bg-[#f6f8fa]"><TableRow>{["Started", "Name", "Duration", "Lane", "Tested build", "Status"].map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{entries.map(entry => <HistoryRow key={entry.kind === "unavailable" ? `${entry.sourceKind}:${entry.id}` : `${entry.kind}:${entry.kind === "suite" ? entry.suiteId : entry.runId}`} entry={entry} routines={routines} now={now}/>)}</TableBody>
    </Table>
  </div>;
}
