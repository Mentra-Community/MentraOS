# Canonical routine case cutover

The follow-up API remains unavailable until `ROUTINE_CASE_API_ENABLED=true` is
explicitly set after this finite cutover. There is one current writer and no
legacy intake adapter. This does not enable automatic failure agents or alter
lane restoration.

1. Disable the prior controller intake, suspend its worker CronJobs, unload its
   three Mini consumers, and verify no matching process or active worker remains.
   Save the operator shutdown receipt and hashes of its evidence files.
2. Export every `routine_cases` document and routine-failure/linked `agent_runs`
   document from the actual old namespace. Keep the full local backup. Do not
   assume it is the Core database.
3. Rehearse the finite conversion using the exact SHA-256 of both the inventory
   file and shutdown receipt:

   ```sh
   bun cloud-v2/packages/core/src/operations/convert-routine-cases-cli.ts \
     rehearse /private/inventory.json INVENTORY_SHA256 \
     /private/drain.json DRAIN_SHA256 /private/rehearsal.json
   ```

   Rehearsal writes verified immutable history to existing artifact storage;
   it makes no Mongo writes. Full old cases, branch attempts, occurrence inbox
   documents and shutdown evidence remain in the history archive. Current
   records preserve case IDs, occurrence IDs, branch keys and anchors. Unknown
   historical routine/platform/source fields remain unavailable.
4. Review the finite counts, preserved identities and exact claim settlement.
   A retained claim is refused unless the shutdown receipt proves that exact
   case/revision/generation/owner/anchor was quiescent before launch. Expiry is
   insufficient. No source record is deleted or mutated.
5. With the new Core writer still disabled, provision the target's existing
   `MONGO_URL` and artifact storage plus one-time source connection variables
   `ROUTINE_CASE_SOURCE_MONGO_URL` and `ROUTINE_CASE_SOURCE_DATABASE`. Apply the
   same files/digests with `apply`. The CLI rechecks the live source graph against
   the reviewed export before any target write. It inserts cases and migration
   activity transactionally; rerunning the exact conversion keeps identical
   records and refuses to overwrite a changed current case.
6. Verify target counts, archive digests and original ID/anchor references.
   Set the managed Core `ROUTINE_CASE_API_ENABLED=true` only after this proof and
   the old consumer's continued shutdown are recorded. Never run two writers.

The authenticated Admin facade is `/api/admin/test-runs/follow-ups`. Host callers
use `/api/internal/routine-cases` with the existing enrolled-host credential;
case updates also require the exact owner token, branch/anchor and generation.
An expired claim is not reassigned automatically. Its exact owner can explicitly
hold/release it, after which a new claim increments the existing generation.
Operator metadata edits do not start an agent or create an inbox item.
