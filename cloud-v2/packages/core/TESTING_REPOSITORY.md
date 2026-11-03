# Testing repository cutover

Core selects new testing source and Actions deliveries with `TESTING_REPOSITORY`.
An unset value keeps `Mentra-Community/Mentra-Automated-Testing`. The only other
accepted value is `Mentra-Community/Mentra`.

| Repository | Canonical ref | Source root | Trusted workflow |
| --- | --- | --- | --- |
| Mentra-Community/Mentra-Automated-Testing | refs/heads/main | repository root | .github/workflows/routine-device.yml@refs/heads/main |
| Mentra-Community/Mentra | refs/heads/dev | testing/ | .github/workflows/routine-device.yml@refs/heads/dev |

The repository fixes all three other values; Core accepts no independent ref,
path, or workflow override. Set the selector through the owning Core Doppler
configuration and its native Porter sync at cutover step 7, after the new release
is installed and the trusted runner workflow is ready. Keep it unset or explicitly on the legacy value while the
bridge release is being prepared and installed.

New unpublished selections pin `routineRepository`; Actions receipts pin the
repository, ref, source root and exact workflow before dispatch. Missing fields
on stored originals always mean the legacy target. Retries, downloads, discovery,
cancellation, and token caches use the pinned identity rather than the selector.
Existing request IDs, digests, sources and review URLs are not rewritten.

Canonical bundle uploads and collection publications explicitly send
`repository: "Mentra-Community/Mentra"`, so step 6 publication does not depend on
the step 7 selector. Omitted publication metadata remains legacy. Inventory paths
stay archive-relative (`routines/...`); definition and step provenance paths use
the actual repository root (`testing/routines/...` in Mentra). New installed
framework bindings explicitly carry the repository; absence remains legacy.

App PR requests accept pinned Mentra or MentraOS identity. GitHub App grants and
in-memory tokens are restricted and cached by scope plus repository. The
`TESTING_TEST_RUN_GITHUB_APP_{ID,PRIVATE_KEY,INSTALLATION_ID}` names take precedence
over `TEST_RUN_GITHUB_APP_ID`, `TEST_RUN_GITHUB_APP_PRIVATE_KEY`, and
`TEST_RUN_GITHUB_INSTALLATION_ID`; `TESTING_TEST_RUN_GITHUB_INSTALLATION_ID`
also remains an installation-id alias. App access and secret configuration
are deployment prerequisites. Mentra native build workflows must supply the existing
exact producer/receipt contract before those builds can be used; check delivery
alone does not prove artifact publication or device execution.
