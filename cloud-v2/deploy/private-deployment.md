# Mentra Private Deployment contract

This is the cloud-neutral operator contract for a Mentra Private Deployment.
The customer runs Core and Runtime as separate services from one immutable,
public OCI image. Platform templates configure these processes; they do not
require a customer-specific fork or APK.

```text
ghcr.io/mentra-community/mentra-cloud:<release-identity>
ghcr.io/mentra-community/mentra-cloud:<source-commit>
ghcr.io/mentra-community/mentra-cloud@sha256:<digest>
```

Deploy the digest form. Tags are discovery aids. The current image targets
`linux/amd64`, has no default command, and is started twice:

| Service | Command |
| --- | --- |
| Core | `bun packages/core/src/index.ts` |
| Runtime | `bun packages/runtime/src/index.ts` |

Core owns persistent users, refresh sessions, signing keys, Runtime-token
minting, and miniapp-token minting. Runtime owns device/media capabilities and
receives only Core's public verification material. Do not give Runtime Core's
private keys or database credentials.

## Configuration boundaries

| Class | Examples | Storage |
| --- | --- | --- |
| Service configuration | URLs, module selectors, issuer metadata, ports, version floors | Container environment |
| Secrets | Mongo credentials, refresh pepper, signing private keys, ACS connection string | Secret manager/container secret references |
| Mentra App policy | Workspace name, service URLs, auth, branding, legal links, miniapps, glasses, features, telemetry | Deployment manifest served by Runtime |

Never put secrets in the image, deployment manifest, command line, or source
repository.

## Core configuration

| Variable | Kind | Meaning |
| --- | --- | --- |
| `PORT` | Public | HTTP port; defaults to `3000`. |
| `MONGO_URL` | Secret | Persistent Mongo-compatible database URI. |
| `REFRESH_TOKEN_PEPPER` | Secret | Stable high-entropy refresh-token hashing key. |
| `MENTRA_JWT_PRIVATE_KEY` | Secret | Ed25519 PKCS#8 body for access and Runtime tokens. |
| `MENTRA_JWT_PUBLIC_KEY` | Public verification material | Matching Ed25519 SPKI body. |
| `MENTRA_MINIAPP_JWT_PRIVATE_KEY` | Secret | Separate Ed25519 PKCS#8 body for miniapp tokens. |
| `MENTRA_MINIAPP_JWT_PUBLIC_KEY` | Public verification material | Matching Ed25519 SPKI body. |
| `CLOUD_CORE_ISSUER` | Public | Deployment-unique HTTPS Core origin. |
| `CLOUD_CORE_OIDC_PROVIDERS` | Public | Explicitly trusted workforce OIDC providers as JSON. |

Signing keys and the refresh pepper must survive upgrades. An Entra provider is
configured explicitly:

```json
[
  {
    "id": "workforce",
    "protocol": "oidc",
    "providerKind": "microsoft-entra",
    "tenantId": "acme-private",
    "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "jwksUrl": "https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys",
    "audience": "<core-api-client-id>",
    "subjectClaim": "oid",
    "directoryTenantClaim": "tid",
    "expectedDirectoryTenantId": "<tenant-id>",
    "requiredScopes": ["mentra.session"],
    "allowedClientIds": ["<mobile-client-id>"]
  }
]
```

Core issues an opaque Mentra user id. It retains provider metadata only for host
integrations such as proving an ACS token belongs to the same Entra employee.
Miniapp tokens never contain the federated identity.

## Runtime modules

`RUNTIME_SERVICES` is a comma-separated positive allowlist. Unknown names fail
startup. When absent, blank, or `full`, Runtime retains the legacy Mentra Cloud
profile: `realtime-audio,camera,maps,tts`; it does not implicitly add meetings.

| Value | Surface/dependencies |
| --- | --- |
| `realtime-audio` | WebSocket, UDP ingest, Redis ownership/workers, transcription. |
| `camera` | Photo and managed-stream routes; currently requires `realtime-audio`. |
| `maps` | Directions, geocoding, and places. |
| `tts` | Speech synthesis. |
| `meetings` | Native meeting credential exchange. |

The first call-focused profile is:

```text
RUNTIME_SERVICES=meetings
MEETING_PROVIDERS=acs-teams
```

It needs public `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`, plus secret
`ACS_CONNECTION_STRING`. It does not need Redis, UDP, Cloudflare, Soniox,
ElevenLabs, Mapbox, or object storage. Runtime trusts only Core-issued tokens:

```text
CLOUD_RUNTIME_AUTH_AUDIENCE=cloud-runtime
CLOUD_RUNTIME_AUTH_ISSUERS=[{"issuer":"https://core.workspace.example","jwksUrl":"https://core.workspace.example/.well-known/jwks.json","userIdClaim":"sub","tenantIdClaim":"tenant_id","algorithms":["EdDSA"]}]
```

Provider enablement is explicit, never inferred from whether an API key exists.

## Deployment manifest

Runtime accepts exactly one of `DEPLOYMENT_MANIFEST_JSON` or an absolute
`DEPLOYMENT_MANIFEST_PATH`. Setting both fails startup. Runtime limits the JSON
to 256 KiB, validates feature/module consistency, and serves it with `no-store`:

```text
GET /.well-known/mentra-deployment.json
```

Important schema-v1 fields are:

| Field | Contract |
| --- | --- |
| `deploymentId`, `displayName` | Stable local namespace and workspace name. |
| `services.coreUrl`, `services.runtimeUrl` | Required by the first template. Null never falls back to Mentra services. |
| `auth` | Exact Entra tenant, Mentra App public-client id, `mentra.session` scope, optional Teams scopes. |
| `branding.logoUrls` | Optional light/dark PNGs. |
| `systemMiniapps.approvedPackageNamesOverride` | Allowlist for SYSTEM miniapps embedded in the Mentra App. |
| `miniapps.managed` | Userland bundle package, version, URL, and SHA-256 descriptors. |
| `miniapps.configuration` | Optional non-secret package-scoped string values. |
| `features` | Explicit mobile/Runtime capability policy. |
| `telemetry` | Whether the workspace permits Mentra telemetry. |

Most miniapps ignore `miniapps.configuration`. A miniapp that explicitly
supports a customer backend may read an optional `backendUrl` through
`session.configuration`; if absent it retains its compiled consumer default.

### Miniapp backend authentication

Core mints the same package-scoped miniapp tokens used by Mentra Cloud. A
backend dedicated to one Private Deployment verifies them locally with
`@mentra/auth` and must explicitly trust that deployment's Core:

```ts
const auth = createMentraAuth({
  packageName: "com.example.remoteassist",
  issuer: "https://core.workspace.example",
  jwksUrl: "https://core.workspace.example/.well-known/jwks.json",
})
```

Do not rely on `@mentra/auth`'s Mentra Cloud defaults in a customer backend,
and never accept an issuer or JWKS URL supplied by a client or token. A
backend shared by Mentra Cloud and multiple Private Deployments needs an
explicit issuer-to-JWKS trust list; that multi-Core helper is a later SDK
addition, not a reason to produce customer-specific miniapp bundles.

The Runtime rejects feature/module mismatches: `runtimeRealtimeSession` needs
`realtime-audio`, `managedStreams` needs `camera`, `nativeMeetings` needs
`meetings`, `cloudSpeech` needs `realtime-audio` or `tts`, and `navigation`
needs `maps`. `onDeviceSpeech` needs no Runtime module.

Optional same-origin assets use `DEPLOYMENT_PRIVACY_PATH`,
`DEPLOYMENT_TERMS_PATH`, `DEPLOYMENT_LOGO_LIGHT_PATH`,
`DEPLOYMENT_LOGO_DARK_PATH`, and `DEPLOYMENT_MANAGED_MINIAPP_DIR`.

## Cloud-neutral Compose example

This shows the process boundary. Put secrets in an uncommitted Compose secret
mechanism and terminate TLS in customer ingress. Mongo is not host-exposed.

```yaml
services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes: ["mongo-data:/data/db"]

  core:
    image: ghcr.io/mentra-community/mentra-cloud@sha256:<release-digest>
    command: ["bun", "packages/core/src/index.ts"]
    restart: unless-stopped
    environment:
      MONGO_URL: mongodb://mongo:27017/mentra-private
      REFRESH_TOKEN_PEPPER: ${REFRESH_TOKEN_PEPPER:?required}
      MENTRA_JWT_PRIVATE_KEY: ${MENTRA_JWT_PRIVATE_KEY:?required}
      MENTRA_JWT_PUBLIC_KEY: ${MENTRA_JWT_PUBLIC_KEY:?required}
      MENTRA_MINIAPP_JWT_PRIVATE_KEY: ${MENTRA_MINIAPP_JWT_PRIVATE_KEY:?required}
      MENTRA_MINIAPP_JWT_PUBLIC_KEY: ${MENTRA_MINIAPP_JWT_PUBLIC_KEY:?required}
      CLOUD_CORE_ISSUER: https://core.workspace.example
      CLOUD_CORE_OIDC_PROVIDERS: ${CLOUD_CORE_OIDC_PROVIDERS:?required}
    depends_on: [mongo]

  runtime:
    image: ghcr.io/mentra-community/mentra-cloud@sha256:<release-digest>
    command: ["bun", "packages/runtime/src/index.ts"]
    restart: unless-stopped
    environment:
      RUNTIME_SERVICES: meetings
      MEETING_PROVIDERS: acs-teams
      DEPLOYMENT_MANIFEST_PATH: /etc/mentra/mentra-deployment.json
      CLOUD_RUNTIME_AUTH_AUDIENCE: cloud-runtime
      CLOUD_RUNTIME_AUTH_ISSUERS: ${CLOUD_RUNTIME_AUTH_ISSUERS:?required}
      ENTRA_TENANT_ID: ${ENTRA_TENANT_ID:?required}
      ENTRA_CLIENT_ID: ${ENTRA_CLIENT_ID:?required}
      ACS_CONNECTION_STRING: ${ACS_CONNECTION_STRING:?required}
    volumes:
      - ./config/mentra-deployment.json:/etc/mentra/mentra-deployment.json:ro

volumes:
  mongo-data:
```

## Validation, upgrades, and rollback

```bash
curl --fail https://core.workspace.example/healthz | jq
curl --fail https://core.workspace.example/ready | jq
curl --fail https://core.workspace.example/.well-known/jwks.json | jq
curl --fail https://workspace.example/healthz | jq
curl --fail https://workspace.example/ready | jq
curl --fail https://workspace.example/api/client/min-version | jq
curl --fail https://workspace.example/.well-known/mentra-deployment.json | jq
```

Upgrade Core and Runtime to the same new digest while preserving Mongo, secrets,
and the manifest. Rollback restores both services to the previous digest; it
does not generate new keys or restore an older database snapshot.

Verify provenance and the SPDX SBOM before mirroring:

```bash
IMAGE=ghcr.io/mentra-community/mentra-cloud@sha256:<release-digest>
docker pull "$IMAGE"
gh attestation verify "oci://$IMAGE" --repo Mentra-Community/MentraOS
gh attestation verify "oci://$IMAGE" \
  --repo Mentra-Community/MentraOS \
  --predicate-type https://spdx.dev/Document/v2.3
```

The SBOM covers the complete image filesystem, not only enabled services. The
coordinated workflow binds SBOM/provenance to the digest. After the first
publication, a Mentra organization owner sets the `mentra-cloud` GHCR package
visibility to public once in GitHub's package settings; subsequent versions
retain that package visibility. Importing the digest into ACR, ECR, or another
OCI registry changes transport, not the approved source.

The repository-level identity integration test exercises the real Core and
Runtime HTTP servers against MongoDB:

```bash
RUN_PRIVATE_DEPLOYMENT_E2E=true \
MONGO_URL=mongodb://127.0.0.1:27017/mentra-private-e2e \
bun test tests/private-deployment-auth.integration.test.ts
```
