---
status: active
owner: philippe
---

# Restore Mentra Call on iOS and qualify a real Teams call

Branch: `codex/enable-mentra-call-ios`, based on dev `c06ccbea30fd961a90253a1f3f46dbe68e77e2e6`. Keep the recorded harness on `codex/mentra-e2e-harness`; integrate this branch there for local Mac testing. Call's external source is `Mentra-Community/Mentra-Call` main, currently `6ab859d499321e7bc394f3113db8e024649e7faa` (2.1.13).

The user requested iOS enablement and fixes, will provide Mentra Live glasses for pairing, and authorized opening the resulting Teams link in a browser to verify the remote participant's experience. Reported failure: the CTO completed the pre-join checklist but joining still failed. No report ID or exact error is available yet; reproduce the failing stage and retain its underlying error. Physical pair identity is pending. This supersedes the earlier local-Mac-only visibility allowance.

- [x] Create an isolated branch from dev.
- [x] Inspect existing native ACS, media and hotspot paths. Both WHEP and local WHIP exist on iOS; do not rely on the superseded structural-impossibility spike.
- [ ] Restore Call install/catalog visibility and migrate the policy-forced hidden flag once. Preserve subsequent user hiding and China restrictions.
- [ ] Run focused migration/policy tests and existing Swift media/audio suites; build and install the integrated local iOS-on-Mac app.
- [ ] Identify the user's Mentra Live pair, pair through the real app, record build/firmware/transport identity, and inspect Call's native accessibility surface.
- [ ] Compile and record the English Call routine: home/settings, joining/creating, link retrieval, browser participant, media observation, mute, leave and cleanup.
- [ ] Reproduce reported iOS failures and fix the shared state/media path. Update Call main/version/ZIP only if its source needs changes.
- [ ] Verify a controlled Teams meeting from the browser: live changing glasses video and audio delivery, consistent participant/call state, mute behavior and cleanup. Mere local CONNECTED state is insufficient.
- [ ] Retain failures and qualify deterministic repeatability. Document Mac Mini setup and which checks require a physical iPhone.
- [ ] Publish the separate iOS PR with actual validation and outstanding hardware gates.

Known platform distinction: the iOS hotspot helper currently waits specifically for cellular internet during direct-link calls. A Mac has no cellular interface; the existing cloud/WHEP path is a separate selectable transport. Do not infer iPhone SoftAP results from a Mac cloud-path run, silently switch transports, or disrupt the user's networking to manufacture a pass.
