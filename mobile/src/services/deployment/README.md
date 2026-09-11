# Deployment configuration

Every active deployment has a schema-v1 `DeploymentManifest`:

- **Official Mentra:** `officialManifest.ts` embeds the consumer defaults. Expo's
  `EXPO_PUBLIC_CLOUD_CORE_URL` and `EXPO_PUBLIC_CLOUD_RUNTIME_URL` still take
  precedence over the shared Cloud Dev defaults. Store links respect the existing
  regional app configuration. The selection is persisted, but the official
  manifest is reconstructed from the installed build, never restored from an old
  build's cached values.
- **Workspace:** the resolver downloads and validates the customer's manifest.
  Consumer environment variables do not change these defaults. The cached source
  manifest remains unchanged when debugging.

`debugOverrides.ts` resolves the selected manifest with the active Core/Runtime
overrides. `cloudClient.ts` adapts that effective manifest for the engine. Login's
Core requests, boot's Runtime version check, Debug Settings, startup, and manual
or automatic cloud reconnects all use the same endpoint resolver. Manifest
fields also supply the app's links, wallpapers, feature settings, and allowlists.
Authentication still selects the provider appropriate to the manifest's mode;
the remote workspace validator continues to require Microsoft Entra.

## Debug overrides

The existing `cloud_core_url` and `cloud_runtime_url` settings remain the only
stored URL overrides. `cloud_url_deployment` identifies their owning deployment
(consumer, or workspace ID plus origin). Older, unscoped values remain valid for
consumer mode only. Build-environment changes still clear these settings.

Debug Settings shows baseline and effective URLs for both deployment types:

- **Save & Test** verifies both endpoints, saves the overrides together, and
  reconnects. A probe completed after an organization switch cannot save into
  the new deployment.
- **Reset** clears the overrides and restores the selected manifest's URLs. It
  clears the old backend's cached version requirement before retrying and does
  not leave the workspace. URL writes own cache invalidation so a delayed React
  effect cannot erase a freshly fetched requirement.
- **Restart** keeps the overrides. `metro-auto` resolves against the current
  Metro host each time; if unavailable, it uses the selected manifest's defaults.
- **Logout or organization selection** clears active Core, Runtime, and OTA
  overrides. Credential expiry alone does not change deployment configuration.
  Reconfirming consumer login keeps its overrides. Deployment changes wait for
  the clear to persist. A failed write leaves the selection unchanged and
  restores the previous overrides for retry; storage failure during restoration
  is reported too.

`engine.dev` uses the host resolver when present; other engine hosts retain their
existing explicit URL behavior. A partial URL update preserves the other override
only when both belong to the same deployment (including legacy consumer values).
An explicit `cloudClientService.reconnect({core, runtime})` pins those endpoints;
`reconnect(null)` resumes the live manifest resolver. Endpoint overrides do not change Entra authority,
scopes, feature policy, or miniapp configuration. The target backend must support
the selected deployment's authentication.

## OTA compatibility

The official manifest reads `EXPO_PUBLIC_ASG_OTA_VERSION_URL`. Its engine adapter
preserves the existing embedded-engine release fallback and pre-39 glasses
protocol behavior. Workspace OTA uses the manifest's source, with `null` meaning
disabled. A deliberate OTA debug override takes precedence for workspaces too,
and remains gated by Super Mode. Reset restores the manifest policy; absent an
override, workspaces never inherit an official/device-reported OTA URL.

STT/TTS model base URL fields remain reserved as described in the deployment
manifest reference; this change does not add model hosting support.
