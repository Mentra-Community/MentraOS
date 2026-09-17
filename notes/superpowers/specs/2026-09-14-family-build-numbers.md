---
status: active
owner: philippe
---

# Family build numbers

One formula for every store build number in a release family, for the Mentra
App (iOS build number and Android version code) and the ASG client (Android
version code) alike, so a number says which release it belongs to and every
channel of a family orders naturally on both stores.

## Formula

```
buildNumber = MAJOR × 100,000,000 + MINOR × 1,000,000 + PATCH × 10,000 + sequence
```

- `MAJOR` 2..20, `MINOR` 0..99, `PATCH` 0..99. The largest code, 20.99.99 with
  sequence 9,999, is 2,099,999,999, under Android's 2,100,000,000 limit. Major 20
  is decades away; a wider major would strand every device in the field below
  the 2.1 billion cap, and was rejected.
- The window of a family `X.Y.Z` is `prefix + 1 .. prefix + 9,999`.
- Release sequences (dev, beta, production) use 1..2,999; non-release builds use
  3,000..9,999 (see below).
- Two legacy namespaces sit below every window and are ignored by allocation:
  the timestamp scheme of the pre-coordinated releases (below 60 million) and the
  first coordinated ASG allocator's `100,000,000 + run number`. The Mentra App's
  3.1.0 betas and the first 3.2.0 dev builds used a flat `310,000,000 + run
number`, above their families' windows; Android testers on those builds
  reinstall once. Glasses are never a floor: the phone can downgrade the ASG
  client through the detour (reinstall the firmware's system app, then upgrade to
  the target).

## Sequences restart per family

Every new family prefix starts again at 1. A coordinated run (dev or beta)
allocates **one sequence per run** from the family's build container
(`mentra-builds-vX.Y.Z`): the next free number above every
`mentra-build-number-<code>.json` marker recorded there and above every ASG
client pair `mentra-live-asg-<code>-<fingerprint>` of the family in the shared
ASG release (numbers taken before markers existed). The marker names its
owner (`coordinated-run:<run id>`, `promotion:<promotion id>:candidate`,
`promotion:<promotion id>:compatibility-lab`, `example:<release set>`), and is
published right after the container exists and before any build starts:

- two owners choosing the same number produce different bytes, so the
  immutable publisher refuses the second one and that run fails closed;
- the same owner retrying republishes identical bytes;
- an owner that finds its own marker among the ones above its floor reuses that
  number instead of allocating again, so a partially published promotion
  attempt or example release resumes with the numbers it already reserved;
- a coordinated rerun keeps the number from its restored plan.

Release identities (`3.1.1-beta.235`) keep the coordinated run number: that is
only a name, not a build number.

### The ASG client shares the run's number

In a coordinated run the ASG client's fingerprint (its sources plus the family
base version) is looked up in the container:

- fingerprint already published: the run reuses that APK and its recorded code,
  no build, no new number;
- new fingerprint: the run builds and stamps the APK with exactly the number
  the run reserved, the same number the app gets in that run; a different
  build already holding that code in the ASG release is a hard stop;
- rerun: same commit, same fingerprint, so the published pair is reused; an
  interrupted pair is deleted and rebuilt.

App and ASG codes are therefore equal whenever both were built in the same run,
and both live in the family window otherwise.

### Production candidates

Production is one more run of the family: the promotion's prepare step takes
the next family sequence from the same container and records its marker there
before anything is built, so the candidate is above the promoted beta and above
every earlier build of the family, and no later coordinated run can take the
number. The store inventories are still frozen for the record of the current
public app, but they play no part in allocation; the family container is the
single source of truth and nothing higher is expected on the stores. The
production Bluetooth example allocates the same way. A compatibility-lab
rebuild of the current public app takes the next sequence of that app's own
family, from that family's container. Google Play production must still be
exceeded, which the family window guarantees over the legacy timestamp codes.

## Google Play track floors

Google Play refuses a release on a track when the release that track currently
serves has a higher version code ("does not allow any existing users to
upgrade"). The floor is per track, it is the served release, and it cannot be
lowered: a completed release can only be halted when an earlier completed
release on the same track takes over, and the earliest one can never be
halted. Nothing uploaded to Play can be deleted.

Before this formula the Mentra App's dev and beta channels stamped
`310000000 + run number` and the aborted 3.1.0 candidate stamped 900000002, so
the `internal` track serves 900000002 and the `beta` (open testing) track
serves 310000212. Both sit above every family window below 3.10, permanently.
The Play `production` track serves the legacy timestamp code 50572796, below
every family window, so production is the one track the formula can always
reach.

The pipeline therefore uses Play like this:

- **Betas** distribute through Google Play Internal App Sharing, which has no
  version-code floor and serves Play-signed builds: the record's `google-play`
  publication carries the coordinate `com.mentra.mentra:<code>:internal-app-sharing`
  and the Play download link, which the Slack notification also shows. This is
  the same path the compatibility lab already used. Testers who hold a
  pre-formula build uninstall once to take the lower code.
- **Production candidates** upload straight to the `production` track as a
  draft release that nothing in the pipeline rolls out. The prepare step's
  guard (candidate above the served production release) is exactly Play's rule
  for that track. Store submission verifies that draft and no longer promotes
  from a testing track.
- **Dev** on the dev branch keeps its Play upload paused (`googlePlayUpload`
  in the plan) for the same reason.

When a fresh closed testing track exists for betas (and one for candidates, if
tester installs of the candidate are wanted again), point the channel at it in
`coordinated-release.yml` and in the expected coordinate map in
`release-family.mjs`; the contract test keeps the two in step. A new closed
track starts with no served release, so its floor is empty.

## Non-release builds (local and PR CI)

Local builds and PR CI builds of the app and the ASG client pin

```
sequence = 3,000 + (minutes since 2025-01-01 of the HEAD committer time) mod 7,000
```

- Derived from the commit, so the app and the ASG client built from the same
  commit share the code, in CI and on a laptop, without any shared counter.
- Always above every release of the family: a dev build installs over the store
  app without an uninstall, and a PR ASG build is an OTA update for glasses on a
  release build. Going back down costs one uninstall on Android (or
  `adb install -r -d` for debug builds) and the detour on glasses.
- Minutes, not seconds: with 7,000 slots the sequence wraps every 4.9 days,
  which covers iterating on a PR with glasses attached; seconds would wrap every
  two hours. Two commits in the same minute share a code, which only matters
  for a glasses OTA between them.
- Uniqueness beyond that is not a goal: Android accepts equal codes on install,
  and crash reports carry the commit hash.

The pull-request ASG workflow (`mentra-asg-client-build.yml`, dev's lane, ported
to staging with the 3.1.1 bump) fingerprints the PR's ASG sources exactly like
the coordinated lane and reuses the coordinated APK when one matches; otherwise
it builds the PR's own ASG client at the commit-derived number and publishes a
per-PR OTA manifest (`ota-pr-<number>-<sha>.json` on the `pr-builds` release)
that the PR's app build pins, so a PR APK updates glasses to the PR's ASG
client. The pull-request app builds pin the same commit-derived number.

## Where it lives

- `.github/scripts/release-family.mjs`: prefix, window, `familyBuildNumber`,
  `buildNumberBelongsTo`, the release-sequence limit.
- `.github/scripts/allocate-family-build-sequence.mjs`: per-run allocation from
  the family container (coordinated plan job).
- `.github/scripts/allocate-asg-version.mjs`: ASG reuse or allocation at the
  run's number.
- `mobile/scripts/build-number.mjs`, `asg_client/app/build.gradle`: pinned by
  CI for releases; the commit-derived non-release band otherwise.
- `.github/scripts/select-pr-asg.mjs`: pull-request ASG reuse or build at the
  commit-derived number.
