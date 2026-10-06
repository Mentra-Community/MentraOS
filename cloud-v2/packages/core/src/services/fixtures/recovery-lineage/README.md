# Notes recovery lineage regression

These are the exact reviewed metadata packets for the retained Notes navigation
failure and its later owner return. They contain five original asset descriptors
and nine recovery asset descriptors; asset bytes, account credentials and raw
recordings are not included.

- Original: `notes-phone-navigation-94a94236-dfdf-4cc5-8a84-3f43aeb4a69f`
- Recovery: `recovery-8d966499afe217907a26dd98f4051b08-2`
- Owner return implementation: Mentra-Automated-Testing PR #219
- Original file SHA-256: `57978d8fade171daa3f47b15a74aefa25738ef456949fbd710b47fbe81457030`
- Recovery file SHA-256: `fb86d05ff1d791d8436f8f977d3f230fe910f46465322b05d6e653ccf1be8f45`

The failed test and incomplete recording evidence remain unchanged. Only the
teardown and fixture outcome improve. These packets demonstrate a development
recovery, not full Notes, CI or physical-device qualification.

Core validates the exporter's deterministic generation ID, the already accepted
original and immediate parent, original terminal hash, a different current
terminal hash, routine/request/source/build identity and retained failure keys.
It records the exact parent payload digests beside the new immutable payload.
This validates published result ancestry, not the unuploaded native journal or
physical completion of cleanup.

Inherited references name the failure's owning result and payload digest. Only
new or changed failures enter the existing delivery outbox. Failure comparison
ignores ordering of asset IDs, incident IDs and missing-evidence entries; message,
code, stack, redaction and declared diagnostic bytes remain significant. Reads
resolve the original current delivery receipt and case link. Missing referenced
records fail visibly instead of hiding the failure.

When the original or immediate parent was not published, or legacy ancestry
cannot be proved, the result still publishes with ordinary independent failure
intake and an explicit `unavailableReason`. This preserves the existing recovery
overview path for an original upload that never reached Core; it grants no
deduplication on the strength of an unverified original-run ID.
Before any unavailable fallback, the published original still constrains its
test and evidence outcomes. Every published original or parent constrains the
incoming identity, test outcome, finish time, terminal hashes and retained
failures. Missing legacy source metadata disables
deduplication without disabling checks against the other known identity fields.

Exact replays preserve existing occurrence projections and acknowledgments.
Legacy rows with no occurrence projection can be reconciled by replaying their
exact metadata; an already accepted recovery with an older projection is never
silently rewritten. Further generations can derive a legacy parent's ancestry
on demand, bounded to 20 ancestors. They reference that parent's own already
accepted occurrences and receipts; no historical incidents are merged or erased.
