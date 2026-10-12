# Routine catalog

Open Routine catalog in Admin (`/?routineCatalog=1`). The controller enrolls
source definitions from `routines/<id>/routine.ts`; no catalog list or video ID
is maintained by hand. Each supported platform has a current source revision.

A card opens a stable routine page with the latest complete passing recording
for that revision, English requirements and steps, and paginated run history.
An enrolled routine without a current passing example is shown as awaiting a
pass. Historical runs stay accessible without qualifying changed actions.

The existing Admin authentication and result asset service serve the page and
recording. Cloud definitions describe tests; host orchestration owns allocation,
setup, teardown and disposal. There is one catalog implementation; no rollout flag or hardcoded fallback.
An empty catalog means the controller has not enrolled definitions yet.

Controller source enrollment, dispatch and suite integration must be verified
with a real published run before claiming end-to-end availability.
