#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregateCycle, loadBugbotVerdict, loadReviewOutput } from './aggregate.js';
import { pollBugbotCheck, triggerBugbot } from './bugbot.js';
import {
  fetchWorkflowStatuses,
  getChangedFiles,
  getPrHeadSha,
  isCiFailed,
  isCiGreen,
  pollCiUntilSettled,
  requiredWorkflowsForPaths,
} from './ci-gates.js';
import { loadConfig } from './config.js';
import { fetchExternalFindings, type ExternalFindings } from './external-reviews.js';
import { runFix } from './fix.js';
import { postInlineFindings } from './inline-comments.js';
import { buildHandoffComment } from './handoff.js';
import { runPlan, writePlanOutputs } from './plan.js';
import { recheckHandoff } from './recheck-handoff.js';
import { buildReviewComment } from './review-comment.js';
import { runCodexReview } from './review-codex.js';
import { runReview } from './review.js';
import {
  createOctokit,
  ensureLabel,
  loadOrCreateState,
  removeLabel,
  saveState,
  upsertMarkerComment,
} from './state.js';
import { MARKER_HANDOFF, MARKER_REVIEW, type ReviewSlot } from './types.js';

const repoRoot = process.env.GITHUB_WORKSPACE ?? process.cwd();
const owner = process.env.GITHUB_REPOSITORY_OWNER!;
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]!;
const prNumber = Number(process.env.PR_NUMBER);
const headSha = process.env.HEAD_SHA ?? '';
const baseRef = process.env.BASE_REF ?? 'main';

async function cmdPlan() {
  const plan = await runPlan(repoRoot);
  console.log(JSON.stringify(plan, null, 2));
  await writePlanOutputs(repoRoot, plan);
}

async function cmdReview(slot: string) {
  const { state } = await loadOrCreateState(createOctokit(), owner, repo, prNumber);
  if (slot === 'codex') {
    await runCodexReview(repoRoot, prNumber, baseRef, state);
    return;
  }
  if (slot !== 'standards' && slot !== 'depth') {
    throw new Error('slot must be standards, depth, or codex');
  }
  await runReview(repoRoot, slot, prNumber, baseRef, state);
}

async function cmdBugbotTrigger() {
  await triggerBugbot(createOctokit(), owner, repo, prNumber);
}

async function cmdBugbotPoll() {
  const config = loadConfig(repoRoot);
  const result = await pollBugbotCheck(
    createOctokit(),
    owner,
    repo,
    headSha,
    config.limits.maxBugbotWaitMin,
    config.limits.bugbotStartGraceMin,
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `bugbot_completed=${result.completed}\n`);
    appendFileSync(out, `bugbot_success=${result.success}\n`);
    appendFileSync(out, `bugbot_started=${result.started}\n`);
  }
  console.log(JSON.stringify(result));
}

async function cmdAggregate() {
  const octokit = createOctokit();
  const { state, commentId } = await loadOrCreateState(octokit, owner, repo, prNumber);

  const activePair = (process.env.ACTIVE_PAIR ?? 'bugbot,standards')
    .split(',')
    .filter(Boolean) as ReviewSlot[];

  const changedFiles = await getChangedFiles(octokit, owner, repo, prNumber);
  const required = requiredWorkflowsForPaths(changedFiles, repoRoot);
  const ref = (await getPrHeadSha(octokit, owner, repo, prNumber)) || headSha;
  const ciChecks = await fetchWorkflowStatuses(octokit, owner, repo, ref, required);

  // Ingestion of external bot inline comments must never take down the cycle:
  // on API failure we proceed without them and pick them up next cycle.
  let external: ExternalFindings | undefined;
  try {
    external = await fetchExternalFindings(
      octokit,
      owner,
      repo,
      prNumber,
      repoRoot,
      state.cycle,
    );
  } catch (err) {
    console.warn('external review ingestion failed; continuing without:', err);
  }

  // Absent/blank means "unknown" (e.g. the Bugbot job did not run), which must
  // keep the conservative treatment. Only an explicit `false` drops the slot.
  const bugbotStartedRaw = process.env.BUGBOT_STARTED;
  const bugbotStarted =
    bugbotStartedRaw === undefined || bugbotStartedRaw === ''
      ? undefined
      : bugbotStartedRaw === 'true';

  const reviews = {
    standards: loadReviewOutput(repoRoot, 'standards'),
    depth: loadReviewOutput(repoRoot, 'depth'),
    codex: loadReviewOutput(repoRoot, 'codex'),
    bugbot: await loadBugbotVerdict(octokit, owner, repo, prNumber),
    bugbotCheckCompleted: process.env.BUGBOT_COMPLETED === 'true',
    bugbotCheckSuccess: process.env.BUGBOT_SUCCESS === 'true',
    bugbotStarted,
    external,
  };

  const result = aggregateCycle(repoRoot, state, reviews, ciChecks, activePair);

  await saveState(octokit, owner, repo, prNumber, result.state, commentId);

  // Always surface the human-readable review to the PR, regardless of verdict.
  const reviewComment = buildReviewComment(
    result.state,
    {
      standards: reviews.standards,
      depth: reviews.depth,
      codex: reviews.codex,
      bugbot: reviews.bugbot,
    },
    activePair,
    { nativeReviewers: reviews.external?.reviewers, bugbotStarted },
  );
  await upsertMarkerComment(octokit, owner, repo, prNumber, MARKER_REVIEW, reviewComment);

  // Inline comments are best-effort: an anchor rejection must not fail the cycle.
  if (result.newBlockingFindings.length > 0) {
    try {
      await postInlineFindings(octokit, owner, repo, prNumber, ref, result.newBlockingFindings);
    } catch (err) {
      console.warn('posting inline finding comments failed; continuing:', err);
    }
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `should_fix=${result.shouldFix}\n`);
    appendFileSync(out, `should_handoff=${result.shouldHandoff}\n`);
    appendFileSync(out, `handoff_reason=${result.handoffReason ?? ''}\n`);
    appendFileSync(out, `ci_failed=${result.ciFailed}\n`);
    appendFileSync(out, `fix_round=${result.state.fixRound}\n`);
    appendFileSync(out, `needs_continuation=${result.needsContinuation === true}\n`);
  }

  console.log(JSON.stringify(result, null, 2));
}

async function cmdFix() {
  const octokit = createOctokit();
  const { state, commentId } = await loadOrCreateState(octokit, owner, repo, prNumber);
  const ciLog = process.env.CI_LOG_EXCERPT ?? '';
  const { ran } = await runFix(repoRoot, state, ciLog);
  if (ran) {
    const next = { ...state, fixRound: state.fixRound + 1 };
    await saveState(octokit, owner, repo, prNumber, next, commentId);
  }
}

async function cmdWaitCi() {
  const config = loadConfig(repoRoot);
  const octokit = createOctokit();
  const ref =
    (await getPrHeadSha(octokit, owner, repo, prNumber)) || headSha;
  const changedFiles = await getChangedFiles(octokit, owner, repo, prNumber);
  const required = requiredWorkflowsForPaths(changedFiles, repoRoot);
  const checks = await pollCiUntilSettled(
    octokit,
    owner,
    repo,
    ref,
    required,
    config.limits.maxCiWaitMin,
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `ci_green=${isCiGreen(checks)}\n`);
  }
  console.log(JSON.stringify(checks, null, 2));
}

async function cmdRecheckHandoff() {
  const octokit = createOctokit();
  const { state, commentId } = await loadOrCreateState(octokit, owner, repo, prNumber);
  const result = await recheckHandoff(repoRoot, octokit, owner, repo, prNumber, state);
  await saveState(octokit, owner, repo, prNumber, result.state, commentId);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `should_handoff=${result.shouldHandoff}\n`);
    appendFileSync(out, `handoff_reason=${result.handoffReason ?? ''}\n`);
    appendFileSync(out, `needs_continuation=${result.needsContinuation === true}\n`);
  }
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Re-trigger the orchestrator for a PR whose diff matches no CI gate. Such a
 * PR receives no `workflow_run` completion, so without this nudge the loop
 * stops after one cycle and never banks enough clean cycles to hand off.
 * Bounded by `limits.maxSelfDispatches`; the state write happens before the
 * dispatch so a crash cannot double-spend the budget.
 */
async function cmdContinue() {
  const config = loadConfig(repoRoot);
  const octokit = createOctokit();
  const { state, commentId } = await loadOrCreateState(octokit, owner, repo, prNumber);

  const max = config.limits.maxSelfDispatches;
  if (state.selfDispatches >= max) {
    console.log(`Self-dispatch budget spent (${state.selfDispatches}/${max}); not continuing`);
    return;
  }

  const next = { ...state, selfDispatches: state.selfDispatches + 1 };
  await saveState(octokit, owner, repo, prNumber, next, commentId);

  await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: 'pr-agent-orchestrator.yml',
    ref: process.env.TOOL_REF || baseRef,
    inputs: { pr_number: String(prNumber) },
  });
  console.log(
    `Self-dispatched next cycle (dispatch ${next.selfDispatches}/${max}) for PR #${prNumber}`,
  );
}

async function cmdFinalize() {
  const reason = (process.env.HANDOFF_REASON ?? 'human_handoff') as
    | 'human_handoff'
    | 'budget_exhausted'
    | 'diverging';
  const octokit = createOctokit();
  const { state, commentId } = await loadOrCreateState(octokit, owner, repo, prNumber);
  const ref = (await getPrHeadSha(octokit, owner, repo, prNumber)) || headSha;
  const changedFiles = await getChangedFiles(octokit, owner, repo, prNumber);
  const required = requiredWorkflowsForPaths(changedFiles, repoRoot);
  const ciChecks = await fetchWorkflowStatuses(octokit, owner, repo, ref, required);

  const finalState = { ...state, status: reason };
  await saveState(octokit, owner, repo, prNumber, finalState, commentId);

  const body = buildHandoffComment(reason, finalState, ciChecks);
  // Upsert so late CI re-triggers edit one handoff comment instead of spamming.
  await upsertMarkerComment(octokit, owner, repo, prNumber, MARKER_HANDOFF, body);

  await ensureLabel(octokit, owner, repo, prNumber, 'ready-for-human-review');
  if (reason !== 'human_handoff') {
    await ensureLabel(octokit, owner, repo, prNumber, 'agent-needs-human');
  }
  if (isCiFailed(ciChecks)) {
    await ensureLabel(octokit, owner, repo, prNumber, 'agent-ci-failing');
  } else {
    await removeLabel(octokit, owner, repo, prNumber, 'agent-ci-failing');
  }
  await removeLabel(octokit, owner, repo, prNumber, 'agent-in-progress');
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  switch (command) {
    case 'plan':
      await cmdPlan();
      break;
    case 'review':
      await cmdReview(arg!);
      break;
    case 'bugbot-trigger':
      await cmdBugbotTrigger();
      break;
    case 'bugbot-poll':
      await cmdBugbotPoll();
      break;
    case 'aggregate':
      await cmdAggregate();
      break;
    case 'fix':
      await cmdFix();
      break;
    case 'wait-ci':
      await cmdWaitCi();
      break;
    case 'recheck-handoff':
      await cmdRecheckHandoff();
      break;
    case 'continue':
      await cmdContinue();
      break;
    case 'finalize':
      await cmdFinalize();
      break;
    case 'help':
    default:
      console.log(`Usage: cli.ts <command>
  plan | review <standards|depth|codex> | bugbot-trigger | bugbot-poll
  aggregate | fix | wait-ci | recheck-handoff | continue | finalize`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
