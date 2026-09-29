import type { FixFlow, FixFlowCurrentState, FixFlowList } from "../../../../packages/core/src/types/fix-flow.types";
import { currentStateInfo, flowCurrentState } from "../lib/fix-flow-groups";
import { fixFlowHref } from "../lib/fix-flow-links";
import type { LaneCard } from "./test-lanes";

const LINK = "text-[#087d50] underline underline-offset-2";
const CURRENT_MS = 120_000;
const responsibility: Record<FixFlowCurrentState, string> = {
  investigating: "Automated fixer", fixing: "Automated fixer", testing: "Automated fixer", reviewing: "Automated fixer",
  queued: "Automated fixer", "worker-active": "Automated fixer", "waiting-review": "PR reviewer",
  "waiting-build": "Build system", "waiting-routine": "Test runner", "waiting-merge": "PR merge owner",
  "waiting-input": "Requested respondent", "worker-repair": "Fixer operator", stopped: "Fix-flow owner",
  merged: "None for this fix", closed: "Fix-flow owner", unknown: "Unconfirmed",
};

/** This is a historical result link, not a new owner or proof of what caused the lane's current state.
 * An invalid owner never falls back to a fixture alias or an older run. */
export function laneFailureRun(card: LaneCard): string | undefined {
  if (!card.fresh || card.state !== "recovery") return undefined;
  const { observation, publishedRunIds } = card.item;
  const runId = observation.owner ? card.runId
    : observation.fixture.checked && observation.fixture.record === "valid" ? observation.fixture.lastRunID : undefined;
  return runId && publishedRunIds.includes(runId) ? runId : undefined;
}

export function laneFailureFlows(card: LaneCard, feed: FixFlowList | undefined, now: number): FixFlow[] {
  const runId = laneFailureRun(card);
  if (!runId || !feed) return [];
  const age = now - Date.parse(feed.refreshedAt);
  const current = Number.isFinite(age) && age >= 0 && age <= CURRENT_MS && feed.activity === "available";
  return feed.flows.filter(flow => flow.runId === runId && /^tfo_[a-f0-9]{64}$/.test(flow.occurrenceId ?? ""))
    .map(flow => current && ["available", "pending"].includes(flow.activity) ? flow : { ...flow, currentState: "unknown" });
}

function inputStatus(state: FixFlowCurrentState) {
  if (state === "waiting-input") return "Requested — open the fix flow for the question.";
  if (state === "waiting-merge") return "A merge decision is needed; see the linked fix flow.";
  if (["unknown", "stopped", "worker-repair", "closed"].includes(state)) return "Unconfirmed — check the linked flow's next action.";
  return "No input request reported.";
}

/** Reuses Core's exact occurrence/ACK/owner projection; never derives agent activity from a lane or CI state. */
export function LaneFailureContext({ card, feed, onResult }: {
  card: LaneCard; feed?: FixFlowList; onResult: (id: string) => void;
}) {
  const runId = laneFailureRun(card);
  if (!runId) return null;
  // A query response can arrive after the page's last timer tick. Judge its freshness
  // at this render, not against that older tick (which could make the response look future-dated).
  const flows = laneFailureFlows(card, feed, Date.now());
  return <section className="mt-3 space-y-2 rounded-lg border border-[#dec694] bg-[#fffaf0] p-2.5 text-[11px]" aria-label="Recorded failure follow-up">
    <p className="font-semibold">Last recorded run · <button className={LINK} onClick={() => onResult(runId)}>Open result</button></p>
    {flows.length ? flows.map(flow => {
      const state = flowCurrentState(flow), info = currentStateInfo(flow);
      return <div key={flow.occurrenceId} className="space-y-1 border-t border-[#ebdfc8] pt-2">
        <p className="font-medium">{flow.step ? `${flow.step.label} (${flow.step.id})` : flow.failure.code}</p>
        <p>{flow.failure.message}</p>
        {flow.failure.detailUnpublished ? <p className="text-[#805619]">Detailed cause is not included in this failure summary. Open the result for any attached evidence.</p> : null}
        <p><strong>Fix flow:</strong> <a className={LINK} href={fixFlowHref({ occurrenceId: flow.occurrenceId! })}>{info.label}</a></p>
        <p><strong>Responsible:</strong> {state === "queued" && !flow.agent ? "Failure intake" : responsibility[state]}</p>
        <p><strong>Next:</strong> {state === "unknown" ? info.description : flow.nextAction}</p>
        <p><strong>Your input:</strong> {inputStatus(state)}</p>
      </div>;
    }) : <p>{!feed ? "Fix-flow status has not loaded." : feed.activity !== "available" ? "Fix-flow status could not refresh."
      : "No fix flow for this exact run was found in the current view."} Responsible party and input needs are unconfirmed. Open the result for its recorded evidence.</p>}
    <p className="text-[#68746d]">These are linked failure records. Fixture recovery remains unverified; a queued or completed fix does not release the lane.</p>
  </section>;
}
