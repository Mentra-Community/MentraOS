# Device results in release Slack posts

The existing dev/staging release post can replace its pending routine section
with the completed result and recording link. Downloads, release checks and OTA
targets stay in the same message. Release publication does not wait for testing.

## One-time configuration

| GitHub setting | Value |
| --- | --- |
| Environment `build-notifications` → secret `SLACK_BUILDS_BOT_TOKEN` | Slack bot token with `chat:write` |
| Repository variable `SLACK_DEV_BUILDS_CHANNEL_ID` | ID of `#dev-builds` |
| Repository variable `SLACK_STAGING_BUILDS_CHANNEL_ID` | ID of `#staging-builds` |

Create the environment in [MentraOS environment settings](https://github.com/Mentra-Community/MentraOS/settings/environments).
Store the token there; it does not need a repository-secret slot. Allow the
`dev` and `staging` branches. Leave required reviewers and wait timers off for
unattended notifications.

Three GitHub-hosted jobs select this environment: `coordinated-release.yml`'s
`notify-slack`, and `notify-release-routine.yml`'s `resolve` and `update`. The
resolver needs it because it checks token availability before producing work.
These are ordinary jobs, not `workflow_call` jobs: GitHub resolves the secret
from each job's environment, without passing it through `secrets: inherit`.
The sibling reusable build jobs do not receive this environment secret.
Existing repository webhook secrets and channel variables remain available.

Trigger behavior is unchanged: initial release posts run only on dev/staging
pushes; the result updater accepts manual/callback dispatch on `dev`. A manual
coordinated build does not post. Example and production notifications keep
their existing workflows and webhook configuration.

Invite that bot to both existing channels. The same bot must author and update
the post. Do not use the reports bot merely because its token already exists.
No Slack history permission is required. The token is used only by GitHub-hosted
notification jobs, never by the hardware worker.

Without this configuration, the existing incoming webhook still delivers the
release post and says **Terminal Slack updates unavailable; use the results
link**. Historical webhook posts have no retained editable receipt and are not
modified automatically.

## Flow

1. The release workflow posts with `chat.postMessage`, then retains
   `release-slack-message-RUN-ATTEMPT`: exact channel/message timestamp, bot,
   original blocks and verified build/archive identity.
2. The private worker retains a small `routine-terminal-RUN-ATTEMPT` artifact
   after execution, export, publication and settlement. It contains outcome
   flags and request identity, not device logs, account information or secrets.
3. A GitHub-hosted private completion callback uses the existing GitHub App to
   dispatch `notify-release-routine.yml` on trusted MentraOS `dev`. Inputs are
   private run ID/attempt selectors, never message text or a Slack destination.
4. The public workflow authenticates the private `main` attempt, the source
   request, published build and retained message. It edits that message with
   `chat.update`. Notification-only retries are separate from the original
   artifact publication attempt; the first matching editable post is retained.

`Passed` requires a passing test, teardown, return verification, ready fixture,
complete evidence, acknowledged settlement and successful result publication.
Uploading a result is different from passing it. Runs stopped before a terminal
receipt exists do not claim a Slack result; their workflow remains the diagnostic
source. PR requests use this same authenticated callback to post one comment
per worker run/attempt/routine on the originating PR; they do not need Slack
configuration. See [PR result history](../../.github/DEVICE-ROUTINES.md#results-and-slack).

## Concurrent routines and retries

Updates to one post use GitHub's `concurrency.queue: max`, so a pending Call
update does not replace a pending OTA update. This has GitHub's 100-pending-job
limit; overflow/cancelled workflows must be rerun explicitly.

Each updater combines its result with the last retained full desired message.
It retains the combined state **before** calling Slack. The latest request
generation wins within a routine, while other routine rows are preserved.
Reapplying that complete message is safe after a failed or ambiguous
`chat.update`; it never creates a replacement post. Missing/expired state after
an earlier update is a visible notification error, not permission to erase old
results. Keep notification artifacts/history for the period that builds remain
testable. Initial `chat.postMessage` has no blind HTTP retry.

GitHub documents `queue: max`; local actionlint 1.7.12 has not yet added that
key. Validate all other rules while excluding only that exact unknown-key
diagnostic, and remove the exclusion when actionlint supports it.

Validate configuration with one new dev release and its no-glasses result.
Staging uses the identical path; no verification commits on staging are needed.
The sister private-worker change and bot setup must be present before terminal
updates can occur. A software test/PR approval is not live Slack verification.
