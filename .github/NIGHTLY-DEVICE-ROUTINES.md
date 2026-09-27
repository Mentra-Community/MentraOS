# Nightly device routine runbook

The [nightly workflow](workflows/nightly-device-routines.yml) targets five routines
on each latest verified coordinated **dev** and **staging** publication:

| Required routine | Platform | Current integration |
| --- | --- | --- |
| `day1-ota` | iOS on Mac | Registered; needs qualified enrolled runtime and fixture |
| `mentra-call` | iOS on Mac | Registered; needs independent Call media/audio/network qualification |
| `account-miniapps` | iOS on Mac | Author-owned combined routine; unavailable until its real worker is registered and qualified |
| `connected-glasses` | Android | Author-owned combined routine; unavailable until its real worker is registered and qualified |
| `livestreamer` | iOS on Mac | Planned author-owned routine covering Livestreamer's WebRTC **Stream here** and local RTMP; unavailable until its real worker is registered and qualified |

Planning, registration and qualification are separate steps. A planned target is
catalogued in [`device-routines.mjs`](scripts/device-routines.mjs) with its name,
label, platform and a `pending` reason. That wires its request choice, Slack row,
terminal filename and PR result rendering, but every execution path refuses it:
PR label and explicit requests, dispatch planning, the private callback and the
nightly send all require `registeredRoutine`. The planner lists it as unavailable
with its exact `pending` text and never requests it. Core lists it with a `planned`
reason that deployment enablement cannot override, and the private worker refuses
it during preparation before any claim. Registration is not a passing device result
either. No-glasses tests requested after each coordinated build remain unchanged
and stay the only successful-build defaults. The scheduler creates no commits or
builds.

Each planned routine's remaining owner contract:

- `account-miniapps`: the owner's `admitAccountMiniappsRun` still refuses
  (`safari-google-provider`), and `worker/account-miniapps.ts` exports no automatic
  preparation. Its `createAccountMiniappsHost` installs the host configuration's
  static build and finalizes development evidence. The missing export must bind
  the request's selected Mac build and claim-bound evidence.
- `connected-glasses`: the owner's `admitConnectedGlassesRun` still refuses with
  its observation blockers, and its Wi-Fi connect, gallery delivery and YouTube
  audio sections are still pending. `worker/connected-glasses.ts` exports no
  automatic preparation that verifies the request's APK through
  `verifySelectedAndroidApk` and records claim-bound Android evidence.
- `livestreamer`: no host exists; the owner must add `worker/livestreamer.ts`
  exporting `prepareLivestreamerWorker(configRef, mode, expectedRequest)` backed by
  an editable Stream here and local RTMP flow with owned receiver and network
  cleanup.

Registering one is a single reviewed change: remove its `pending` (public) and
`planned` (Core), route its private enrolled configuration to the owner's completed
lifecycle instead of `worker/planned-routine-intake.ts`, and add its label to
`request-e2e-routine.yml`'s `pull_request` trigger and `REQUEST_ROUTINE` chain.

## Schedule and exact selection

Midnight is `America/Los_Angeles`. The 07:00 and 08:00 UTC triggers cover daylight
saving time; only the applicable trigger proceeds, including transition dates.
GitHub delivery can be delayed for at most six hours. Later delivery fails rather
than silently changing the night.

For each channel, inspect the latest 20 successful coordinated runs, newest first.
A candidate needs the successful immutable-publication step, its retained Actions
plan artifact, current channel ancestry and verified plan/receipt/archive/OTA
metadata. A green dry run is insufficient. Select the newest candidate with a
verified archive for at least one registered required platform, then **freeze that
publication for every routine on the channel**. Mac and Android selections must
share source commit, release identity, release-plan hash and OTA-manifest hash.

A missing platform stays unavailable on that selected publication; it does not
silently use an older build. A missing worker registration also stays unavailable,
with no substitute walkthrough. The separate availability job reports these gaps
while eligible members proceed. The summary names each routine, platform, release,
source run and publication attempt. It is a request summary, not a test verdict.

## Independent requests and resource ownership

Each matrix member calls **Request device routine** on trusted `dev`, with its
routine, exact source run/attempt and `request_origin: workflow-dispatch`. The
optional schema-2 marker is authenticated against the scheduled run and that
member's entered send step:

```json
{"sequence":{"kind":"nightly-routine","runId":123,"runAttempt":1,"member":"mentra-call"}}
```

The producer revalidates the selected publication and publishes immutable request
JSON. Its ordinary trusted callback queues the usual private `device-routine.yml`
job. The private worker independently verifies the request and enrolled runtime,
then uses the existing shared claim, app/device/audio leases, setup, cleanup,
verified return and result publisher. No extra queue or Mini polling daemon exists.

One routine's failed test verdict does not gate another. Call requires its own
fresh, manifest-compatible commissioned fixture and live preflight, including the
checks repeated under its lease. A failed Day1 run with a verified usable return
can therefore leave Call eligible; a retained/unknown fixture cannot. Independent
resources may run concurrently. Shared app, glasses, network or audio resources
must serialize through their existing ownership checks.

Each date/channel/routine has its own entered-send fence. Partial history, an
ambiguous response, a prior entered send or an attempt rerun refuses another send.
The generated request workflow must also remain attempt 1; rerunning it cannot
bypass this fence. A cancellation before the send step does not consume the member. Legacy whole-pair
sends fence both OTA and Call during migration. Other independent members remain
eligible. Never delete scheduler history or rerun it to repeat hardware actions;
reconcile the existing request/claim before a deliberate new request.

Already-published `nightly-ota-call` markers retain their original paired private
workflow and strict OTA prerequisite. They are not reinterpreted as independent
requests. New nightly requests use only the ordinary callback.

## Activation and results

`DEVICE_ROUTINE_NIGHTLY_ENABLED` must equal `true` to schedule requests. This source
change does not enable it. Before enabling:

1. Merge the private marker/intake support and enroll a clean reviewed runtime
   containing it. Dispatcher and enrolled runtime revisions can differ; a newer
   dispatcher does not make an older runtime understand the new marker.
2. Merge the public producer/callback/scheduler and Core overview projection to
   `dev`, the default branch. Complete the three author-owned routine registrations
   (`account-miniapps`, `connected-glasses` and `livestreamer`) as described above.
   Selectors, parsers, platform routing (`connected-glasses` is Android only),
   enrollment keys and runner labels already exist; enrolling a planned routine
   still ends in its preparation refusal.
3. Qualify **each** full recorded routine, its setup/verified return, resource
   transitions and actual queue-to-admin publication. Call qualification includes
   the browser-peer recording, two-way audio, background operation and independent
   internet route. Livestreamer qualification covers both WebRTC **Stream here**
   and local RTMP. A partial development recording is not full qualification.
4. Confirm existing scoped GitHub App dispatch/read configuration and separate
   Core claim/upload capabilities. The scheduler mints a MentraOS-only Actions-write
   App token so its request emits the downstream callback. That callback separately
   mints the private dispatch token; the scheduler needs no private-repository credential.
5. Enable the variable only after those gates. Verify the next applicable run's
   ten member requests/results (five routines on each of two channels). Verify integration on dev; do not create staging
   verification commits or manual staging qualification runs.

Authorized operator commands, after qualification:

```bash
gh variable set DEVICE_ROUTINE_NIGHTLY_ENABLED --repo Mentra-Community/MentraOS --body true
# Stop future schedules without interrupting existing writes or cleanup:
gh variable set DEVICE_ROUTINE_NIGHTLY_ENABLED --repo Mentra-Community/MentraOS --body false
```

Public Actions retains request JSON and summaries. Private workers retain original
local evidence and upload immutable results/assets to the configured Core/admin
viewer. Every member has its own request, verdict and return state. Existing
`#dev-builds` and `#staging-builds` posts remain build notifications; their result
links do not imply nightly completion. Credentials, recordings and firmware bytes
remain outside this public source.

Focused offline checks:

```bash
node --test .github/scripts/nightly-device-routines.test.mjs \
  .github/scripts/request-e2e-routine.test.mjs \
  .github/scripts/coordinated-routine-request.test.mjs \
  .github/scripts/dispatch-device-routine.test.mjs \
  .github/scripts/notify-pr-builds.test.mjs \
  .github/scripts/pr-routine-result.test.mjs \
  .github/scripts/release-routine-slack.test.mjs
```

These synthetic metadata checks exercise no hardware and do not enable scheduling.
The five-by-two chain tests use a labelled model of a completed public registration
for the planned routines; a pass there models wiring only and qualifies nothing.
