# Mentra Private Runtime deployment contract

This is the cloud-neutral operator contract for the Mentra Runtime image. The
same digest can run in Azure Container Apps, AWS, Kubernetes, another container
platform, or Docker Compose. Platform templates provision infrastructure; they
must not change Runtime behavior or bake customer configuration into the image.

The coordinated release publishes:

```text
ghcr.io/mentra-community/mentra-runtime:<release-identity>
ghcr.io/mentra-community/mentra-runtime:<source-commit>
ghcr.io/mentra-community/mentra-runtime@sha256:<digest>
```

Deploy the digest form. Tags are discovery aids, not deployment identities.
The current artifact targets `linux/amd64`, uses the ordinary Cloud V2
Dockerfile, and has no default command. Select amd64 nodes (or compatible
emulation), then start Runtime with:

```text
bun packages/runtime/src/index.ts
```

## Configuration boundaries

Keep these three configuration classes separate:

| Class             | Examples                                                                                            | Storage                                         |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Runtime behavior  | `RUNTIME_SERVICES`, provider selectors, ports, version floors, identity-provider public identifiers | Container environment or platform configuration |
| Secrets           | ACS connection string, SaaS API keys, S3 secret key                                                 | Secret manager or container secret reference    |
| Mentra App policy | Workspace name, service URLs, auth, branding, legal links, miniapps, glasses, features, telemetry   | Deployment manifest served by Runtime           |

Do not place secrets in the image, deployment manifest, command line, source
repository, or nonsensitive environment configuration. Environment variables
are an interface: use the target platform's secret references for secret
values.

Runtime always requires `CLOUD_RUNTIME_AUTH_ISSUERS`. Set
`CLOUD_RUNTIME_AUTH_AUDIENCE` when the token audience is not the legacy
`cloud-runtime` default. Issuer entries support a remote `jwksUrl` or a static
`publicKey`/`publicKeyEnv`, identity claim selection, exactly one of
`tenantIdClaim` or `fixedTenantId`, optional `algorithms`, `requiredScopes`, and
`allowedClientIds`.

## Runtime modules

`RUNTIME_SERVICES` is a comma-separated positive allowlist. Unknown names and a
delimiter-only list fail startup. If the variable is absent, blank, or `full`,
Runtime uses the legacy Cloud profile: `realtime-audio,camera,maps,tts`.
That legacy profile does not enable `meetings`.

| Value            | Surface and dependencies                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `realtime-audio` | Runtime WebSocket, UDP audio ingest, Redis ownership and worker pool, transcription. Requires reachable Redis and UDP configuration. |
| `camera`         | `/api/camera` photo and managed-stream routes. Currently requires `realtime-audio`.                                                  |
| `maps`           | `/api/maps` directions, geocoding, and places routes.                                                                                |
| `tts`            | `/api/tts` speech synthesis routes.                                                                                                  |
| `meetings`       | `/api/meetings` native meeting credential exchange. Requires a deployment manifest and at least one `MEETING_PROVIDERS` value.       |

Disabled modules register no routes and do not initialize their dependencies.
Provider enablement is never inferred from whether an API key happens to be
present.

### Providers and required configuration

| Module           | Selector and valid values                                                 | Required configuration                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime-audio` | `AUDIO_PROVIDER=soniox`; `mock` is test-only                              | `REDIS_URL`, `AUDIO_UDP_PORT`, externally reachable `AUDIO_UDP_ADVERTISED_HOST` and optionally `AUDIO_UDP_ADVERTISED_PORT`, plus secret `SONIOX_API_KEY` for Soniox. `AUDIO_WORKERS` controls worker count.                                                                                                                         |
| `camera` storage | `STORAGE_PROVIDER=local` (development), `r2`, or `s3`                     | `local` optionally uses `CAMERA_LOCAL_DIR` and is not a production shared store. `r2`/`s3` require `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, and secret `STORAGE_S3_SECRET_ACCESS_KEY`; `STORAGE_S3_REGION` defaults to `auto`. Remote completion webhooks should use secret `CAMERA_WEBHOOK_SECRET`. |
| `camera` streams | `STREAM_PROVIDER=cloudflare`                                              | `CF_STREAM_ACCOUNT_ID`, secret `CF_STREAM_API_TOKEN` with Stream edit access, and optional `CF_STREAM_CUSTOMER_SUBDOMAIN`. Legacy `CLOUDFLARE_*` aliases remain accepted.                                                                                                                                                           |
| `maps`           | `MAPS_PROVIDER=mapbox`                                                    | `MAPBOX_ACCESS_TOKEN`.                                                                                                                                                                                                                                                                                                              |
| `tts`            | ElevenLabs is currently the only implementation; there is no selector yet | Secret `ELEVENLABS_API_KEY`. Voice, model, speed, stability, similarity, and style have optional `ELEVENLABS_DEFAULT_*` overrides.                                                                                                                                                                                                  |
| `meetings`       | `MEETING_PROVIDERS=acs-teams`                                             | Public `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`, secret `ACS_CONNECTION_STRING`, and optional `ENTRA_TEAMS_TOKEN_AUDIENCE`. The Runtime auth issuer must accept the corresponding employee and mobile-client token.                                                                                                                  |

The call-focused Private Deployment profile is deliberately small:

```text
RUNTIME_SERVICES=meetings
MEETING_PROVIDERS=acs-teams
```

It does not require Redis, UDP, audio workers, storage, Cloudflare, Soniox,
ElevenLabs, or Mapbox.

## Deployment manifest

A Private Deployment that enrolls the Mentra App provides exactly one of:

- `DEPLOYMENT_MANIFEST_JSON`: the complete JSON value; or
- `DEPLOYMENT_MANIFEST_PATH`: an absolute path to a mounted JSON file.

Legacy Cloud profiles may omit both. Setting both fails startup. Runtime limits
the document to 256 KiB, validates
its JSON and schema version, verifies that advertised features match enabled
modules, and serves the normalized document at:

```text
/.well-known/mentra-deployment.json
```

Schema version 1 is strict and contains:

| Field                         | Contract                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`               | Must be `1`.                                                                                                                                                                                                                     |
| `deploymentId`, `displayName` | Stable lowercase/hyphen deployment id and user-facing workspace name.                                                                                                                                                            |
| `branding.logoUrls`           | Optional light/dark PNG URLs. Private Deployment logos must use the workspace origin.                                                                                                                                            |
| `services`                    | Independently nullable `coreUrl` and `runtimeUrl`. The current workspace flow requires Runtime and requires its origin to equal the workspace origin.                                                                            |
| `auth`                        | `mentra-account` or Microsoft Entra configuration in the common schema. The current Private Deployment client supports an exact-tenant `microsoft-entra` authority, mobile client id, Runtime scopes, and optional Teams scopes. |
| `artifacts`                   | Nullable Mentra Live OTA, on-device STT model, and on-device TTS model locations.                                                                                                                                                |
| `appUpdates`                  | `store` or `managed`, plus nullable Android/iOS store and review URLs.                                                                                                                                                           |
| `content`                     | Wallpaper URL list. An empty list disables remote presets.                                                                                                                                                                       |
| `links`                       | Required privacy and terms URLs; nullable documentation and support URLs.                                                                                                                                                        |
| `systemMiniapps`              | Allowlist override for SYSTEM miniapps embedded in the Mentra App. `null` retains the embedded profile; `[]` approves none.                                                                                                      |
| `miniapps.managed`            | Customer-managed userland ZIPs identified by package, semantic version, same-origin `/miniapps/` URL, and SHA-256.                                                                                                               |
| `glasses`                     | Optional pairable-model allowlist override.                                                                                                                                                                                      |
| `features`                    | Explicit mobile capability contract described below.                                                                                                                                                                             |
| `telemetry`                   | Enables or disables Mentra telemetry for the workspace.                                                                                                                                                                          |

All configured production URLs must use credential-free HTTPS without
fragments. Unknown fields are rejected by the Mentra App. Managed miniapp
package names and paths must be unique, and one package cannot be both SYSTEM
and manifest-managed.

The Runtime checks this feature mapping at startup:

| Manifest feature         | Required Runtime service  |
| ------------------------ | ------------------------- |
| `runtimeRealtimeSession` | `realtime-audio`          |
| `managedStreams`         | `camera`                  |
| `nativeMeetings`         | `meetings`                |
| `cloudSpeech`            | `realtime-audio` or `tts` |
| `navigation`             | `maps`                    |

`onDeviceSpeech` is a Mentra App capability and does not enable a Runtime
module. A feature/service mismatch prevents Runtime from starting rather than
advertising a route that is absent or silently starting an unapproved service.

The TypeScript source of truth is
`mobile/src/services/deployment/schema.ts`. The Azure reference's generated
manifest in `deploy/azure/enterprise-reference/main.bicep` is a complete
call-focused example.

### Optional workspace assets

Runtime can serve same-origin customer assets configured through:

- `DEPLOYMENT_PRIVACY_PATH` and `DEPLOYMENT_TERMS_PATH`;
- `DEPLOYMENT_LOGO_LIGHT_PATH` and `DEPLOYMENT_LOGO_DARK_PATH`, which must be
  configured together as PNG files no larger than 512 KiB; and
- `DEPLOYMENT_MANAGED_MINIAPP_DIR`, containing the manifest-pinned ZIP files.

## Common endpoints

These endpoints exist independently of the selected module profile:

| Endpoint                                  | Meaning                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /healthz`                            | Liveness. Returns the Runtime package name and enabled service list.                                                                                   |
| `GET /ready`                              | Readiness. Returns 200 only when every configured dependency check passes; otherwise 503.                                                              |
| `GET /api/client/min-version`             | Returns required and recommended Mentra App versions from `CLOUD_CLIENT_MIN_VERSION` and `CLOUD_CLIENT_RECOMMENDED_VERSION`; each defaults to `0.0.0`. |
| `GET /.well-known/mentra-deployment.json` | Present when a deployment manifest is configured. Served with `Cache-Control: no-store`.                                                               |

## Cloud-neutral Compose example

This example runs the current meetings-only profile. Replace every placeholder,
store `ACS_CONNECTION_STRING` in the deployment system's secret facility, and
mount an actual schema-v1 manifest at `./config/mentra-deployment.json`.

```yaml
services:
  runtime:
    image: ghcr.io/mentra-community/mentra-runtime@sha256:<release-digest>
    command: ["bun", "packages/runtime/src/index.ts"]
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"
    environment:
      NODE_ENV: production
      PORT: "3001"
      RUNTIME_SERVICES: meetings
      MEETING_PROVIDERS: acs-teams
      CLOUD_CLIENT_MIN_VERSION: "3.2.0"
      CLOUD_CLIENT_RECOMMENDED_VERSION: "3.2.0"
      DEPLOYMENT_MANIFEST_PATH: /etc/mentra/mentra-deployment.json
      CLOUD_RUNTIME_AUTH_AUDIENCE: "<runtime-application-client-id>"
      CLOUD_RUNTIME_AUTH_ISSUERS: >-
        [{"issuer":"https://login.microsoftonline.com/<tenant-id>/v2.0","jwksUrl":"https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys","userIdClaim":"oid","fixedTenantId":"<tenant-id>","requiredScopes":["mentra.runtime"],"allowedClientIds":["<mobile-application-client-id>"]}]
      ENTRA_TENANT_ID: "<tenant-id>"
      ENTRA_CLIENT_ID: "<mobile-application-client-id>"
      ACS_CONNECTION_STRING: "${ACS_CONNECTION_STRING:?set ACS_CONNECTION_STRING}"
      LOG_STDOUT_JSON: "true"
      SERVICE_NAME: mentra-runtime
    volumes:
      - ./config/mentra-deployment.json:/etc/mentra/mentra-deployment.json:ro
```

The mounted `config/mentra-deployment.json` is the customer-visible mobile
policy. A complete meetings-only example is:

```json
{
  "schemaVersion": 1,
  "deploymentId": "acme-remote-assistance",
  "displayName": "ACME Remote Assistance",
  "services": {
    "coreUrl": null,
    "runtimeUrl": "https://workspace.example"
  },
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/<tenant-id>",
    "clientId": "<mobile-application-client-id>",
    "runtimeScopes": ["api://<runtime-application-client-id>/mentra.runtime"],
    "teamsScopes": [
      "https://auth.msft.communication.azure.com/Teams.ManageCalls",
      "https://auth.msft.communication.azure.com/Teams.ManageChats"
    ]
  },
  "artifacts": {
    "mentraLiveOtaManifestUrl": null,
    "sttModelBaseUrl": null,
    "ttsModelBaseUrl": null
  },
  "appUpdates": {
    "mode": "managed",
    "storeUrls": {"android": null, "ios": null},
    "reviewUrls": {"android": null, "ios": null}
  },
  "content": {"wallpaperUrls": []},
  "links": {
    "privacyPolicyUrl": "https://legal.example/privacy",
    "termsOfServiceUrl": "https://legal.example/terms",
    "documentationUrl": null,
    "supportUrl": null
  },
  "systemMiniapps": {
    "approvedPackageNamesOverride": ["com.mentra.settings"]
  },
  "miniapps": {"managed": []},
  "glasses": {"allowedModelsOverride": ["mentra-live"]},
  "features": {
    "runtimeRealtimeSession": false,
    "managedStreams": false,
    "nativeMeetings": true,
    "cloudSpeech": false,
    "onDeviceSpeech": false,
    "navigation": false
  },
  "telemetry": false
}
```

The loopback port is suitable behind a reverse proxy. A real Mentra App
workspace requires customer-controlled DNS and TLS, with Runtime and the
well-known manifest exposed through the same HTTPS origin.

Validate the deployment before enrollment:

```bash
curl --fail https://workspace.example/healthz | jq
curl --fail https://workspace.example/ready | jq
curl --fail https://workspace.example/api/client/min-version | jq
curl --fail https://workspace.example/.well-known/mentra-deployment.json | jq
```

## Image, SBOM, and provenance verification

Obtain the digest from the coordinated Mentra release record and verify the
signed GitHub build provenance before importing or deploying it:

```bash
IMAGE=ghcr.io/mentra-community/mentra-runtime@sha256:<release-digest>

docker pull "$IMAGE"
gh attestation verify "oci://$IMAGE" \
  --repo Mentra-Community/MentraOS
gh attestation verify "oci://$IMAGE" \
  --repo Mentra-Community/MentraOS \
  --predicate-type https://spdx.dev/Document/v2.3
```

The SPDX SBOM inventory and build provenance are signed attestations bound to
the image digest. They contain no customer configuration or secrets. Verify the
canonical GHCR subject before mirroring; importing by digest into ACR, ECR, or
another OCI registry changes transport, not the approved source identity.

GHCR packages are private on first publication even for a public source
repository. A Mentra organization administrator must make `mentra-runtime`
public once in the package settings. Public GHCR packages can then be pulled
anonymously and mirrored by customers without GitHub credentials; GitHub does
not permit changing a public package back to private.
