---
status: completed
owner: aisraelov
---

# Shared deployment configuration

Official Mentra and customer workspaces use the same deployment manifest
structure. The official manifest is embedded in the Mentra App and respects
existing Core/Runtime environment variables and regional store links. Hosted
customer manifests retain their current validation and Entra requirements.

The selected source manifest plus deployment-scoped debug overrides produces
the effective configuration. The source manifest is never modified by an
override. Startup, account service requests, minimum-version checks, and cloud
reconnects must resolve the same endpoints.

Debug URL controls work for both official and workspace deployments. Save tests
both endpoints and applies them together. Reset restores the selected manifest;
it does not leave the workspace. A normal restart preserves overrides, while
explicit logout or organization selection clears them. Restoring an existing
consumer login during upgrade is not an organization switch. Existing consumer
overrides and their build-environment reset behavior remain compatible.

Only the owning deployment can use stored overrides. A pending health check
cannot apply its results after an organization switch. Authentication failures
do not switch deployment or identity mode.

The existing OTA debug control also works in workspaces and retains Super Mode
gating. With no override, a workspace uses its declared OTA source, including
explicit null to disable it. Official deployments retain embedded release and
legacy glasses fallback behavior.

Workspace confirmation displays the manifest's workspace name. Settings show
manifest defaults alongside effective cloud URLs.

Teams eligibility and explicit account/external identity selection belong under
`session.meeting` in the Miniapp SDK. That requires provider/host integration and
is outside this configuration change; no silent external fallback is proposed.

Implementation details: [deployment configuration](../../../mobile/src/services/deployment/README.md).
