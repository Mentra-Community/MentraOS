# Routine label applicability

Automatic PR labels are paired with an app publication platform only when the
exact selected Harness definition supports it. Both the publication callback
and PR label event read the selected IDs from Core's existing routine catalog,
freeze that catalog's `routineRevision`, and use its optional `platforms` metadata.
The metadata comes from ordinary immutable definitions at that exact revision.
The automatic occurrence ID depends on the app publication, routine and platform,
as before. A retained Core row supplies its original revision before applicability
lookup, including a cancelled row. A new occurrence reads main once; Core's original
insert atomically freezes its source. Concurrent issuers recover that same winner
rather than creating a new ID or reopening cancelled work. Manual generations and
their explicit source overrides remain separate.

An unsupported combination is skipped with a PR comment naming the routine,
platform and Harness revision. Compatible combinations proceed independently.
If main's exact definition has not published yet, support remains unknown and
the request still proceeds through device-free source preparation. No routine
name or suffix determines applicability, and no earlier collection is substituted.

This check establishes source applicability, not a passing device result. Normal
preparation, host assignment, evidence and cleanup gates still apply.
