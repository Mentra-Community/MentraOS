---
status: active
owner: Philippe
---

# Testing monorepo bridge

Move testing from `Mentra-Community/Mentra-Automated-Testing@main` to
`Mentra-Community/Mentra@dev`, under `testing/`, without invalidating existing
records, source provenance, installed hosts or running operations.

## Contract

- Keep original stored repository, commit, workflow and source paths valid.
  Observe existing requests through their recorded identity after the switch.
- Select new-write repository, branch and source root together from the two
  supported targets. Default to the old target until the dispatch activation step.
- Preserve bounded downloads, merge eligibility and exact App installation
  access. Recognize legitimate historical records without accepting arbitrary
  repositories or source paths.
- Install the bridge before activation. Version ordering, artifact lineage and
  observer workflow identity must survive the transition between Git histories.
- Keep existing resource status and custody semantics. Migration does not grant
  readiness, release retained resources or restart original jobs.
- Run one authoritative publisher at each stage; archive after actual new
  publication, installed acceptance and trusted dispatch are demonstrated.

## Agreed transition

Keep the existing R2 prefix. The imported anchor is final old version + 1;
subsequent first-parent commits increase it. One checked source file declares
`legacyRevision`, `legacyVersion` and `cutoverRevision`. Ordinary Git ancestry
plus that single edge handles the move; genuine old Git objects must remain
available in the new publisher and maintenance checkouts.

The cutover supplies the frozen old head/version, imported anchor and exact host
configuration. The source bridge does not invent these
values or change existing resource claims.
