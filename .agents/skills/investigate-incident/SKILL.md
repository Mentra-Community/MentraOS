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

## Fetch through the existing script

Run `scripts/fetch-incident-logs.sh` from the repository root. It calls
`GET /api/admin/reports/:reportId` and downloads each artifact through
`GET /api/admin/reports/:reportId/artifacts/:artifactId`.

The script reads `MENTRA_ADMIN_TOKEN`. Use it if already configured. Otherwise
check for an existing `MENTRA_ADMIN_TOKEN_PROD` or `MENTRA_ADMIN_TOKEN_DEV`
matching the notification's environment and pass it to this command only:

```bash
MENTRA_ADMIN_TOKEN="$MENTRA_ADMIN_TOKEN_PROD" \
  ./scripts/fetch-incident-logs.sh rep_REPORT_ID --env prod

MENTRA_ADMIN_TOKEN="$MENTRA_ADMIN_TOKEN_DEV" \
  ./scripts/fetch-incident-logs.sh rep_REPORT_ID --env dev
```

Check whether a variable is set without printing its value. Do not print
credentials, enable shell tracing, put tokens in committed files, or extract
browser sessions. If no suitable credential is available, request that the user
configure `MENTRA_ADMIN_TOKEN` in the environment. Authentication requires an
admin-allowlisted org API key (`msk_...`) or an admin WorkOS access token.

Use the environment from the report notification. Without `--env`, the script
tries prod, dev, then staging. `MENTRA_CORE_URL` overrides even `--env`; check
for an unintended override before interpreting a missing report. Distinguish
401 (rejected credential), 403 (not admin-allowlisted), and 404 (wrong ID,
environment, or unavailable endpoint). Report authentication failures directly;
do not fall back to console automation.

Downloads go to gitignored `incident-logs/<reportId>/`. Use `--out` for an
alternative local directory, such as `.context/incidents/<reportId>/`.
`--json` returns detail only; it does **not** download logs. `--list` lists
recent reports and supports `--kind`, `--status`, and `--limit`.

If the report is still `collecting` or an artifact download failed, distinguish
partial evidence from a complete bundle. Re-fetch when uploads have finished;
do not treat absent logs as proof that nothing happened.

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

Correlate timestamps across sources, record the app build and firmware
versions, and compare the reported build with current `origin/dev`. Separate
the user's symptoms, observed log evidence, and hypotheses. Read the owning
module's `AGENTS.md` before editing. BES firmware belongs to `mentra-live-bes`;
follow its guidance and OTA gates if a fix belongs there. Do not assume every
incident needs a mobile or cloud patch.

When a fix is supported by the evidence, add focused regression coverage and
follow the repository's PR workflow if a PR was requested. Include the report
ID, source Slack link, findings, validation, and any required device checks.
Do not reply in Slack, close the report, or deploy firmware merely because an
investigation or PR was requested.
