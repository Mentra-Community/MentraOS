# Release deployment configuration audit

Source and history checked on 15 October 2026 UTC. Dev was `645292f9`, staging
`4e501e14`, and main `52308f15`. Staging and production live settings were not
queried; source differences are not proof of live deployment drift.

## Findings

| Finding | Evidence | Resolution |
| --- | --- | --- |
| Runtime eviction protection would be skipped after promotion | [4783](https://github.com/Mentra-Community/MentraOS/pull/4783) applied its Helm override only when the app was `cloud-dev` | Render the same Runtime policy for all three environments; always pass it through the existing coordinated deployer |
| Three copies could diverge after a scoped edit | At the current dev commit, manifests have identical service behavior after removing identities, groups and domains | One shared Porter service/build file; only guarded identities differ |
| Staging/main source has not received newer config fixes | Their current trees lack Core's 2 GiB ingress setting and retain inline `AUDIO_WORKERS`; the later commits are absent from their ancestry | Promote the reviewed source; no claim that individual changes were accidentally omitted during a promotion |
| A generic legacy manifest remained as an alternate manual path | `porter.yaml` had no active workflow reference; older runbook examples described it | Remove the unused manifest and document the coordinated renderer as the release path |
| Sandbox manifests have deliberate separate consumers | Debug and Isaiah each have dedicated workflows and lack Core's 2 GiB ingress setting | Keep their explicit sandbox scope visible; they are outside the dev/staging/production contract |

## Earlier changes and propagation

- [3653](https://github.com/Mentra-Community/MentraOS/pull/3653) corrected production
  OAuth's stale manually stored environment group. All three current branches
  contain it. The distinct `cloud-v2-prod-doppler-sync` identity is intentional.
- [3838](https://github.com/Mentra-Community/MentraOS/pull/3838) established the
  single coordinated deployment owner; all three branches contain it. Reuse that
  owner rather than adding another workflow.
- [4019](https://github.com/Mentra-Community/MentraOS/pull/4019) fixed deployment
  tooling running from an older frozen source. Preserve the existing split:
  deployment behavior comes from the frozen release; tooling comes from the
  workflow revision.
- [4268](https://github.com/Mentra-Community/MentraOS/pull/4268) initially raised
  dev/staging ingress to 128 MiB after a 413 rejection; production was explicitly
  outside its scope. [4408](https://github.com/Mentra-Community/MentraOS/pull/4408)
  subsequently aligned all three files to 2 GiB. The current staging/main branches
  contain neither change. Their different source behavior reflects promotion lag.
- [4561](https://github.com/Mentra-Community/MentraOS/pull/4561) removed inline
  settings and made Doppler authoritative across all six manifests. It is present
  only in current dev ancestry. Effective live worker settings were not measured.
- [4783](https://github.com/Mentra-Community/MentraOS/pull/4783) protected the dev
  singleton Runtime after two native HTTP 503 failures during a deliberate
  Karpenter underutilization eviction. Its dev-only conditional was a real
  same-source promotion gap, addressed by the shared policy.

## Justified differences and guarantees

App names, linked Doppler groups and public domains differ. Production retains
both regional and canonical hostnames. Release channels and the protected
completed-beta production promotion remain distinct. Current service capacity,
entrypoints, probes, ports, ingress and shutdown behavior have no justified
per-environment differences and are shared.

The renderer preserves concrete logical config paths so frozen deployment-record
validation remains intact. A pre-cutover release missing the shared inputs fails
closed; production needs a newly qualified beta containing the consolidation.
No fallback reads old manifests or inserts current policy into older releases.

CI establishes equivalent generated policy and requires the normal workflow to
carry it. After promotion, actual source, matching PDB/Deployment selectors,
readiness and serving endpoints still need deployment verification. Doppler
values, external dependencies and live state can differ; shared source does not
prove identical runtime behavior under every environment's conditions.

Runtime remains one replica with PDB100 and rolling zero-unavailable/one-surge.
Ordinary eviction-based drain requires planned overlap; retained nodes may forgo
consolidation savings. Abrupt node loss, forceful eviction and WebSocket
continuity remain outside this qualification. Core protection is outside scope.
