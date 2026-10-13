---
name: plan-review-replan
description: >-
  Drafts an implementation plan with the parent (large) model, runs a cheaper
  plan-reviewer subagent critique, then has the parent revise the plan. Use when
  the user invokes /plan-review-replan, asks for plan-then-review, a small-model
  plan review, double-pass planning, or a plan with model critique before build.
disable-model-invocation: true
---

# Plan → Review → Replan

Use only when the user explicitly invokes `/plan-review-replan` or clearly asks
for this double-pass planning workflow.

**Do not write application code** until the user accepts the revised plan.

## Goal

Parent (chat picker — use a large/high-reasoning model) writes the plan.
`plan-reviewer` (pinned to Composer 2.5, not the parent) critiques it.
Parent addresses the review and revises. Repeat up to the round cap.
Optional handoff into native Plan mode for the Build button.

## Hard rules

- Stay in Agent for Phases 1–3 so review → replan can run in one continuous flow.
- Do not call `SwitchMode` until Phase 4 (and only with user consent).
- **Model split is mandatory.** Phase 1 and Phase 3 run on the parent. Phase 2
  must launch the `plan-reviewer` subagent. Never review the plan with the
  parent model.
- When launching `plan-reviewer`, do **not** pass a Task `model` override.
  The subagent frontmatter (`composer-2.5[fast=false]`) must win.
- Max **2** review rounds unless the user asks for more.
- Prefer tools/read-only research; no implementation edits in this skill.
- If the user already pasted or attached a plan, skip Phase 1 drafting and go
  to Phase 2.

## Parallelization and model tiering (applies to every plan)

Every plan must maximize parallel execution and match model capability to task
difficulty. Larger, more capable models take the harder work; smaller, cheaper
models take the easier work.

1. **Decompose** the steps into independent workstreams. Two workstreams are
   independent when they touch disjoint files/modules and neither needs the
   other's output. Give each workstream explicit file ownership so parallel
   agents never edit the same file.
2. **Group into waves.** Everything with no unmet dependency goes in the same
   wave and is launched in a single message as concurrent subagent calls.
   Only serialize where a real dependency exists (shared interface, generated
   code, migration order). State the dependency reason in the plan.
3. **Assign a tier to each workstream:**

   | Tier | Work | Model (from available list) |
   |------|------|-----------------------------|
   | Hard | Architecture, concurrency/BLE/protocol logic, security, tricky debugging, cross-module refactors, anything ambiguous | `claude-fable-5-1-thinking-high`, `claude-opus-5-5-medium`, or `gpt-5.6-sol-high-fast` |
   | Medium | Standard feature implementation, writing tests against a clear spec, moderate refactors | `claude-sonnet-5-5-medium` or `composer-2.5-fast` |
   | Easy | Renames, boilerplate, config/doc edits, repetitive mechanical changes, codebase lookups/search | `composer-2.5-fast`, `gemini-3.8-flash-high`, or `explore` (readonly) |

   Pick only slugs from the current available-models list. If the user asks for
   a model that is not listed, say so instead of substituting.
4. **Never put a hard task on a small model** to save cost, and never spend a
   large model on mechanical work. When unsure, go one tier up for correctness-
   critical code and one tier down for read-only research.
5. **Integration step.** After each wave, the parent (large model) reconciles
   results, resolves conflicts, and runs verification before launching the
   next wave.
6. Plans with a single indivisible task may say "no parallelism possible" but
   must justify it.

## Phase 1 — Plan (parent / large model)

Work exactly like Plan mode, but remain in Agent:

1. Ask clarifying questions only when required (prefer one focused question at a
   time; use `AskQuestion` when available for fixed choices).
2. Research the codebase (search/read relevant modules, existing patterns, tests).
3. Produce a first plan using this structure:

```markdown
# Plan: <short title>

## Goal
<what success looks like>

## Constraints
- <constraints / non-goals>

## Approach
<recommended approach and why>

## Files / areas
- `path` — change intent

## Steps
1. ...
2. ...

## Parallel workstreams
| ID | Task | Depends on | Tier | Agent / model | Files owned |
|----|------|------------|------|---------------|-------------|
| W1 | ... | none | Hard | ... | ... |

Waves: Wave 1 = [W1, W2, W3] (run together), Wave 2 = [W4] (needs W1), ...

## Risks
- <risk> — mitigation

## Test plan
- [ ] ...

## Open questions
- ...
```

4. Show the draft plan to the user briefly, then proceed to Phase 2 without
   waiting for full approval (the review pass is the gate).

## Phase 2 — Small-model review

Launch the `plan-reviewer` subagent via the Task tool
(`subagent_type: "plan-reviewer"`). Pass:

- The user's original request
- The full current plan
- Any critical codebase findings

Do not set Task `model`. Do not use `generalPurpose`, `explore`, or an inline
self-review for this step.

Require structured output:

- **Verdict:** `Pass` | `Needs revision`
- **Blockers:** must-fix gaps (empty if Pass)
- **Gaps:** missing files, steps, tests, or risks
- **Assumptions to validate:** ...
- **Optional improvements:** ...
- **Parallelization audit:** serial steps that could run concurrently, workstreams
  with overlapping file ownership, missing dependency reasons, and tier/model
  mismatches (hard work on a small model, mechanical work on a large one).
  Treat a missing or unjustified `Parallel workstreams` section as a Blocker.

If `plan-reviewer` fails to launch, retry once. If it still fails, stop and tell
the user the cheap-model review did not run — do **not** substitute a
parent-model self-review.

## Phase 3 — Replan (parent / large model)

1. Revise the plan to resolve every blocker and material gap, including the
   parallelization audit: re-split serial steps, fix file-ownership overlaps,
   and correct tier/model assignments.
2. Keep what was correct; do not rewrite from scratch unless the review demands it.
3. Present the **Revised plan** with a short "Changes from review" bullet list.
4. If verdict was `Needs revision` after round 1, run Phase 2 again on the
   revised plan (round 2), then present the second revision.
5. Stop and ask for approval before any implementation.

## Phase 4 — Optional Plan mode handoff

After the user accepts the revised plan, ask exactly:

**Prompt:** `Switch to Plan mode now?`  
**Options:** `Switch to Plan mode now` | `Not yet` | `Something else (I will type it)`

- If they choose **Switch to Plan mode now**: call `SwitchMode` with
  `target_mode_id: "plan"`. In the same turn, tell them to paste or save the
  revised plan and use **Build** when ready.
- If `SwitchMode` is unavailable: tell them to use the mode picker or
  **Shift+Tab**, then Build.
- If **Not yet**: stay in Agent and wait for their next order (implement,
  tweak plan, etc.).

## Invocation examples

- `/plan-review-replan Add BLE retry with backoff for photo transfer`
- `Run plan-review-replan on this feature before we code`
- `Review this plan, then replan` (skip to Phase 2)
