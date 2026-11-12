---
name: investigate-incident
description: >-
  Investigate Mentra App bug reports and feedback from a reports Slack link or
  rep_ report ID. Fetch the report and device artifacts through the Cloud V2
  reports API, then trace the evidence to the responsible source code.
---

# Investigate an incident

Use the API for report detail and artifact downloads. Do not open the admin
console with browser or computer-use tools to retrieve incident logs.

## Resolve the report

For a Slack link, read its message and thread with the Slack connector. A URL
ending in `/archives/CHANNEL/p1789682365377999` identifies channel `CHANNEL`
and message timestamp `1789682365.377999`. Extract the `rep_...` report ID,
environment, symptoms, and relevant replies. The notification's artifact count
can be stale while devices upload; fetch the report's current artifact list.

If Slack access is unavailable and no report ID is known, ask for the ID or
message text. Do not substitute a different recent report.

## Fetch it

In the Mentra monorepo, run `scripts/get-logs report <rep_id> --env <env>` from
its root (the get-logs skill); elsewhere,
`./scripts/fetch-incident-logs.sh <rep_id> --env <env>` from this folder. Both
pick the environment's own key (`MENTRA_PROD_ADMIN_TOKEN`,
`MENTRA_STAGING_ADMIN_TOKEN`, `MENTRA_DEV_ADMIN_TOKEN`) and, when a key is
missing or rejected or the report is on another environment, print the exact
fix: pass it on rather than investigating the script. Check a key by its
variable's name only; never print it, enable shell tracing or extract browser
sessions, and don't use the admin console's pages instead.

If the report is still `collecting` or an artifact failed, the evidence is
partial: fetch again once uploads finish, and don't treat absent logs as proof
that nothing happened. Framework diagnostic bundles are verified and extracted
under `diagnostic-bundle-<sha256>/`, with `manifest.json` mapping each file.

## Investigate the evidence

`report.json` is the API envelope: the document is under `.report`, including
`.report.report` (user description), `.report.context` (device/app snapshot),
and `.report.artifacts`. Log files contain `{entries: [...]}` with timestamps,
levels, messages, and optional sources. Artifacts can include phone, glasses,
glasses firmware, and screenshots; inspect the actual metadata rather than
assuming fixed file numbers or sources.

Select relevant fields and time ranges before displaying output. Context and
log messages may contain credentials, personal information, signed URLs, and
large inline audio payloads. Keep raw bundles local and include only necessary,
redacted excerpts in PRs or responses.

The glasses log is the ASG's structured subset, not its logcat; the
glasses_firmware log is the BES trace. Phone and glasses clocks differ, so line
sources up by event rather than timestamp. Record the app build and firmware
versions, and compare the reported build with current `origin/dev`. Separate
the user's symptoms, observed log evidence, and hypotheses. Read the owning
module's `AGENTS.md` before editing. BES firmware belongs to `mentra-live-bes`;
follow its guidance and OTA gates if a fix belongs there. Do not assume every
incident needs a mobile or cloud patch.

When the incident happens on a device, reproduce it on the lab before fixing
it, as the testing runner's README ("Reproduce a bug") describes: replay a
routine into the state where it happens with `bun lab run <routine> --steps
<first>..<last> --goal "Reproduce <the bug>"`, keep the draft as a repro
routine, measure how often it happens with `--repeat 20`, and give that rate
before and after the fix (`--pr <fix>`, or `--bes` for firmware) in the PR.

When a fix is supported by the evidence, add focused regression coverage and
follow the repository's PR workflow if a PR was requested. Include the report
ID, source Slack link, findings, validation, and any required device checks.
Do not reply in Slack, close the report, or deploy firmware merely because an
investigation or PR was requested.
