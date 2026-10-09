import {createMMKV} from "react-native-mmkv"

import referenceManifest from "../../../../cloud-v2/deploy/azure/enterprise-reference/mentra-deployment.json"
import {storage} from "@/utils/storage"
import {DeploymentResolutionError, normalizeOrganizationOrigin, resolveDeploymentCandidate} from "./resolver"
import {DeploymentStore, type DeploymentStorage, type PersistedDeploymentSelection} from "./store"
import type {DeploymentManifest, OrganizationDeployment} from "./types"
import {MicrosoftEntraDeploymentAuthProvider} from "./auth/MicrosoftEntraDeploymentAuthProvider"

const ORGANIZATION = "https://mentra.enterprise.example"

function manifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    deploymentId: "mentra-enterprise-dev",
    displayName: "Mentra Enterprise Dev",
    branding: {
      logoUrls: {
        light: `${ORGANIZATION}/branding/logo-light.png`,
        dark: `${ORGANIZATION}/branding/logo-dark.png`,
      },
    },
    services: {coreUrl: ORGANIZATION, runtimeUrl: ORGANIZATION},
    auth: {
      mode: "microsoft-entra",
      authorityUrl: "https://login.microsoftonline.com/2e7662c0-e826-4928-95b2-60bdd48d5d95",
      clientId: "c84a504c-6caa-4a00-a6a3-9206cad41218",
      sessionScopes: ["api://11111111-2222-4333-8444-555555555555/mentra.session"],
      teamsScopes: [
        "https://auth.msft.communication.azure.com/Teams.ManageCalls",
        "https://auth.msft.communication.azure.com/Teams.ManageChats",
      ],
    },
    artifacts: {
      mentraLiveOtaManifestUrl: `${ORGANIZATION}/artifacts/mentra-live/version.json`,
      sttModelBaseUrl: null,
      ttsModelBaseUrl: null,
    },
    appUpdates: {
      mode: "managed",
      storeUrls: {android: null, ios: null},
      reviewUrls: {android: null, ios: null},
    },
    content: {wallpaperUrls: []},
    links: {
      privacyPolicyUrl: `${ORGANIZATION}/privacy`,
      termsOfServiceUrl: `${ORGANIZATION}/terms`,
      documentationUrl: `${ORGANIZATION}/docs`,
      supportUrl: `${ORGANIZATION}/support`,
    },
    systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings"]},
    miniapps: {managed: [], configuration: {}},
    glasses: {allowedModelsOverride: ["mentra-live"]},
    features: {
      runtimeRealtimeSession: false,
      managedStreams: true,
      nativeMeetings: true,
      cloudSpeech: false,
      onDeviceSpeech: false,
      navigation: false,
    },
    telemetry: false,
    ...overrides,
  }
}

function response(
  body: string,
  options: {status?: number; url?: string; contentLength?: number; streamed?: boolean} = {},
): Response {
  const status = options.status ?? 200
  const headers = new Headers({"content-type": "application/json"})
  if (options.contentLength !== undefined) headers.set("content-length", String(options.contentLength))
  const encoded = new TextEncoder().encode(body)
  let consumed = false
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url ?? `${ORGANIZATION}/.well-known/mentra-deployment.json`,
    headers,
    body:
      options.streamed === false
        ? null
        : {
            getReader: () => ({
              read: async () => {
                if (consumed) return {done: true, value: undefined}
                consumed = true
                return {done: false, value: encoded}
              },
              cancel: async () => undefined,
            }),
          },
    text: async () => body,
  } as Response
}

describe("normalizeOrganizationOrigin", () => {
  it.each([
    "mentra.enterprise.example/",
    "https://mentra.enterprise.example/path/to/a/homepage",
    "https://mentra.enterprise.example/.well-known/mentra-deployment.json",
    "https://mentra.enterprise.example?organization=example#sign-in",
  ])("normalizes a user-provided organization address %s", (input) => {
    expect(normalizeOrganizationOrigin(input)).toBe(ORGANIZATION)
  })

  it.each([
    "http://mentra.enterprise.example",
    "https://user:password@mentra.enterprise.example",
    "ftp://mentra.enterprise.example",
  ])("rejects unsafe organization input %s", (input) => {
    expect(() => normalizeOrganizationOrigin(input)).toThrow(DeploymentResolutionError)
  })
})

describe("resolveDeploymentCandidate", () => {
  it("resolves and validates a customer manifest", async () => {
    const fetch = jest.fn(async () => response(JSON.stringify(manifest())))
    const candidate = await resolveDeploymentCandidate(ORGANIZATION, {fetch})

    expect(candidate.organizationOrigin).toBe(ORGANIZATION)
    expect(candidate.manifest.auth.mode).toBe("microsoft-entra")
    expect(candidate.manifest.branding?.logoUrls.light).toBe(`${ORGANIZATION}/branding/logo-light.png`)
    expect(fetch).toHaveBeenCalledWith(
      `${ORGANIZATION}/.well-known/mentra-deployment.json`,
      expect.objectContaining({redirect: "manual"}),
    )
  })

  it("defaults older schema-v1 manifests to no managed userland miniapps", async () => {
    const {miniapps: _managedMiniapps, ...value} = manifest()
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).resolves.toMatchObject({
      manifest: {miniapps: {managed: [], configuration: {}}},
    })
  })

  it("rejects cross-origin Runtime", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(manifest({services: {coreUrl: ORGANIZATION, runtimeUrl: "https://runtime.attacker.example"}})),
      ),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "origin-mismatch"})
  })

  it("rejects an organization without Core", async () => {
    const fetch = jest.fn(async () =>
      response(JSON.stringify(manifest({services: {coreUrl: null, runtimeUrl: ORGANIZATION}}))),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects a cross-origin organization logo", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            branding: {
              logoUrls: {
                light: "https://images.attacker.example/logo.png",
                dark: `${ORGANIZATION}/branding/logo-dark.png`,
              },
            },
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "origin-mismatch"})
  })

  it("accepts same-origin manifest-managed userland miniapps", async () => {
    const value = manifest({
      miniapps: {
        managed: [
          {
            packageName: "com.example.remoteassist",
            version: "1.2.0",
            bundleUrl: `${ORGANIZATION}/miniapps/remote-assist-1.2.0.zip`,
            sha256: "a".repeat(64),
          },
        ],
        configuration: {},
      },
    })
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).resolves.toMatchObject({manifest: value})
  })

  it("accepts package-scoped miniapp configuration for an approved package", async () => {
    const value = manifest({
      systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings"]},
      miniapps: {
        managed: [],
        configuration: {
          "com.mentra.settings": {backendUrl: `${ORGANIZATION}/settings-api`},
        },
      },
    })
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).resolves.toMatchObject({manifest: value})
  })

  it("rejects miniapp configuration for a package the deployment does not approve", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings"]},
            miniapps: {
              managed: [],
              configuration: {
                "com.example.unapproved": {backendUrl: `${ORGANIZATION}/unapproved-api`},
              },
            },
          }),
        ),
      ),
    )

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects oversized miniapp configuration values", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings"]},
            miniapps: {
              managed: [],
              configuration: {
                "com.mentra.settings": {backendUrl: "x".repeat(2_049)},
              },
            },
          }),
        ),
      ),
    )

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects cross-origin, duplicate, and SYSTEM-overlapping managed miniapps", async () => {
    const entry = {
      packageName: "com.example.remoteassist",
      version: "1.2.0",
      bundleUrl: `${ORGANIZATION}/miniapps/remote-assist-1.2.0.zip`,
      sha256: "a".repeat(64),
    }
    const crossOriginFetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            miniapps: {managed: [{...entry, bundleUrl: "https://attacker.example/miniapp.zip"}], configuration: {}},
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: crossOriginFetch})).rejects.toMatchObject({
      code: "origin-mismatch",
    })

    const duplicateFetch = jest.fn(async () =>
      response(JSON.stringify(manifest({miniapps: {managed: [entry, {...entry}], configuration: {}}}))),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: duplicateFetch})).rejects.toMatchObject({
      code: "invalid-manifest",
    })

    const overlapFetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            systemMiniapps: {approvedPackageNamesOverride: ["com.example.remoteassist"]},
            miniapps: {managed: [entry], configuration: {}},
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: overlapFetch})).rejects.toMatchObject({
      code: "invalid-manifest",
    })
  })

  it("rejects managed replacement of a built-in SYSTEM package even with a null system allowlist", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            systemMiniapps: {approvedPackageNamesOverride: null},
            miniapps: {
              managed: [
                {
                  packageName: "com.mentra.settings",
                  version: "1.2.0",
                  bundleUrl: `${ORGANIZATION}/miniapps/settings-1.2.0.zip`,
                  sha256: "a".repeat(64),
                },
              ],
              configuration: {},
            },
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it.each(["v1.2.3", "1.2", "1.2.3-01"])("rejects non-canonical managed version %s", async (version) => {
    const value = manifest({
      miniapps: {
        managed: [
          {
            packageName: "com.example.remoteassist",
            version,
            bundleUrl: `${ORGANIZATION}/miniapps/remote-assist.zip`,
            sha256: "a".repeat(64),
          },
        ],
        configuration: {},
      },
    })
    await expect(
      resolveDeploymentCandidate(ORGANIZATION, {fetch: async () => response(JSON.stringify(value))}),
    ).rejects.toMatchObject({
      code: "invalid-manifest",
    })
  })

  it("rejects query-bearing Core and Runtime base URLs", async () => {
    const value = manifest({services: {coreUrl: `${ORGANIZATION}?core=1`, runtimeUrl: ORGANIZATION}})
    await expect(
      resolveDeploymentCandidate(ORGANIZATION, {fetch: async () => response(JSON.stringify(value))}),
    ).rejects.toMatchObject({
      code: "invalid-manifest",
    })
  })

  it("rejects redirects and oversized responses", async () => {
    const redirectFetch = jest.fn(async () => response("", {status: 302}))
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: redirectFetch})).rejects.toMatchObject({
      code: "redirect",
    })

    const largeFetch = jest.fn(async () => response("{}", {contentLength: 500_000}))
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: largeFetch})).rejects.toMatchObject({
      code: "response-too-large",
    })

    const streamedLargeFetch = jest.fn(async () => response("x".repeat(300_000)))
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: streamedLargeFetch})).rejects.toMatchObject({
      code: "response-too-large",
    })
  })

  it("fails closed when a custom fetch does not expose a streaming body", async () => {
    const unstreamed = response(JSON.stringify(manifest()), {streamed: false})
    unstreamed.text = jest.fn()
    const fetch = jest.fn(async () => unstreamed)

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({
      code: "invalid-manifest",
    })
    expect(unstreamed.text).not.toHaveBeenCalled()
  })

  it("rejects malformed UTF-8 before parsing the manifest", async () => {
    const malformed = response("")
    Object.defineProperty(malformed, "body", {
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0xc3, 0x28]))
          controller.close()
        },
      }),
    })
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch: async () => malformed})).rejects.toMatchObject({
      code: "invalid-manifest",
      message: "Organization manifest body is not valid UTF-8.",
    })
  })

  it("requires an exact Entra tenant authority", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            auth: {
              mode: "microsoft-entra",
              authorityUrl: "https://login.microsoftonline.com/organizations",
              clientId: "c84a504c-6caa-4a00-a6a3-9206cad41218",
              sessionScopes: ["api://11111111-2222-4333-8444-555555555555/mentra.session"],
              teamsScopes: [],
            },
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects organization auth modes not implemented by this release", async () => {
    const fetch = jest.fn(async () => response(JSON.stringify(manifest({auth: {mode: "mentra-account"}}))))
    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("requires the fixed ACS Teams scope pair for native meetings", async () => {
    const value = manifest()
    if (value.auth.mode !== "microsoft-entra") throw new Error("test requires Entra auth")
    value.auth.teamsScopes = ["https://auth.msft.communication.azure.com/Teams.ManageCalls"]
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(ORGANIZATION, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })
})

class MemoryDeploymentStorage implements DeploymentStorage {
  value: PersistedDeploymentSelection | null = null

  load(): unknown | null {
    return this.value
  }

  save(value: PersistedDeploymentSelection): void {
    this.value = value
  }

  remove(): void {
    this.value = null
  }
}

describe("DeploymentStore", () => {
  it("starts unresolved and persists an explicit Mentra or organization selection", async () => {
    const persistence = new MemoryDeploymentStorage()
    const store = new DeploymentStore(persistence)
    expect(store.getActive()).toMatchObject({
      kind: "consumer",
      source: "embedded",
      manifest: {deploymentId: "mentra-official"},
    })
    expect(store.isResolved()).toBe(false)
    expect(store.isTelemetryAllowed()).toBe(false)

    await store.activate({
      organizationOrigin: ORGANIZATION,
      manifestUrl: `${ORGANIZATION}/.well-known/mentra-deployment.json`,
      manifest: manifest(),
    })
    expect(new DeploymentStore(persistence).getActive()).toMatchObject({
      kind: "organization",
      organizationOrigin: ORGANIZATION,
    })
    expect(store.isTelemetryAllowed()).toBe(false)

    await store.returnToMentra()
    expect(store.getActive()).toMatchObject({
      kind: "consumer",
      source: "embedded",
      manifest: {deploymentId: "mentra-official"},
    })
    expect(store.isResolved()).toBe(true)
    expect(store.isTelemetryAllowed()).toBe(true)
    expect(new DeploymentStore(persistence).isResolved()).toBe(true)

    await store.clearSelection()
    expect(store.isResolved()).toBe(false)
    expect(store.isTelemetryAllowed()).toBe(false)
  })

  it("fails closed to consumer for malformed persisted data", () => {
    const persistence = new MemoryDeploymentStorage()
    persistence.value = {kind: "workspace"} as PersistedDeploymentSelection
    expect(new DeploymentStore(persistence).getActive()).toMatchObject({
      kind: "consumer",
      source: "embedded",
      manifest: {deploymentId: "mentra-official"},
    })
    expect(new DeploymentStore(persistence).isResolved()).toBe(false)
  })

  it("fails closed when a persisted manifest violates cross-field validation", () => {
    const persistence = new MemoryDeploymentStorage()
    persistence.value = {
      kind: "workspace",
      source: "manual",
      workspaceOrigin: ORGANIZATION,
      manifestUrl: `${ORGANIZATION}/.well-known/mentra-deployment.json`,
      manifest: manifest({services: {coreUrl: ORGANIZATION, runtimeUrl: "https://attacker.example"}}),
      activatedAt: new Date().toISOString(),
    }
    const store = new DeploymentStore(persistence)
    expect(store.getActive()).toMatchObject({
      kind: "consumer",
      source: "embedded",
      manifest: {deploymentId: "mentra-official"},
    })
    expect(store.isResolved()).toBe(false)
  })
})

// Builds that already shipped wrote this exact JSON under this exact key. The
// in-memory names may change; these persisted names and the key order may not.
class RawDeploymentStorage implements DeploymentStorage {
  value: unknown = null

  load(): unknown | null {
    return this.value
  }

  save(value: unknown): void {
    this.value = value
  }

  remove(): void {
    this.value = null
  }
}

describe("shipped persisted deployment selection", () => {
  const ACTIVATED_AT = "2026-09-22T00:00:00.000Z"
  const SHIPPED = {
    kind: "workspace",
    source: "manual",
    workspaceOrigin: ORGANIZATION,
    manifestUrl: `${ORGANIZATION}/.well-known/mentra-deployment.json`,
    manifest: manifest(),
    activatedAt: ACTIVATED_AT,
  }
  // Re-activate exactly what was restored, so the saved JSON proves the restore.
  const reactivate = (store: DeploymentStore) => {
    const restored = store.getActive() as OrganizationDeployment
    return store.activate({
      organizationOrigin: restored.organizationOrigin,
      manifestUrl: restored.manifestUrl,
      manifest: restored.manifest,
    })
  }

  afterEach(() => jest.useRealTimers())

  it("restores a stored selection and re-saves identical JSON", async () => {
    const persistence = new RawDeploymentStorage()
    persistence.value = JSON.parse(JSON.stringify(SHIPPED))
    const store = new DeploymentStore(persistence)
    expect(store.isResolved()).toBe(true)
    expect(store.getActive()).toMatchObject({kind: "organization", organizationOrigin: ORGANIZATION})

    jest.useFakeTimers({now: new Date(ACTIVATED_AT)})
    await reactivate(store)
    expect(JSON.stringify(persistence.value)).toBe(JSON.stringify(SHIPPED))
  })

  it("round-trips through the MMKV key byte-for-byte", async () => {
    const key = "mentra.deployment.active.v1"
    storage.save(key, SHIPPED)
    const store = new DeploymentStore()
    expect(store.isResolved()).toBe(true)
    expect(store.getActive()).toMatchObject({kind: "organization", organizationOrigin: ORGANIZATION})

    jest.useFakeTimers({now: new Date(ACTIVATED_AT)})
    await reactivate(store)
    expect(createMMKV().getString(key)).toBe(JSON.stringify(SHIPPED))
    storage.remove(key)
  })

  it("keeps the shipped consumer record", async () => {
    const key = "mentra.deployment.active.v1"
    const store = new DeploymentStore()
    await store.returnToMentra()
    expect(createMMKV().getString(key)).toBe(JSON.stringify({kind: "consumer", source: "embedded"}))
    storage.remove(key)
  })
})

describe("MicrosoftEntraDeploymentAuthProvider", () => {
  it("uses the manifest scopes and returns a deployment-scoped identity", async () => {
    const runtimeToken = {
      accountId: "account-1",
      subject: "employee-1",
      tenantId: "tenant-1",
      username: "employee@example.com",
      displayName: "Employee One",
      accessToken: "runtime-token",
      expiresAt: Date.now() + 60_000,
      scopes: ["mentra.session"],
    }
    const native = {
      getAccount: jest.fn(async () => runtimeToken),
      signIn: jest.fn(async () => runtimeToken),
      acquireToken: jest.fn(async (_configuration: unknown, scopes: string[]) => ({
        ...runtimeToken,
        accessToken: scopes.some((scope) => scope.endsWith("/Teams.ManageCalls")) ? "teams-token" : "runtime-token",
        scopes,
      })),
      signOut: jest.fn(async () => {}),
    }
    const deployment: OrganizationDeployment = {
      kind: "organization",
      source: "manual",
      organizationOrigin: ORGANIZATION,
      manifestUrl: `${ORGANIZATION}/.well-known/mentra-deployment.json`,
      manifest: manifest(),
      activatedAt: new Date().toISOString(),
    }
    const provider = new MicrosoftEntraDeploymentAuthProvider(deployment, native)
    if (deployment.manifest.auth.mode !== "microsoft-entra") throw new Error("test requires Entra auth")

    const session = await provider.signIn()
    expect(native.signIn).toHaveBeenCalledWith(
      expect.objectContaining({clientId: deployment.manifest.auth.clientId}),
      deployment.manifest.auth.sessionScopes,
    )
    expect(session.identity).toMatchObject({
      deploymentId: deployment.manifest.deploymentId,
      subject: "employee-1",
      email: "employee@example.com",
    })

    await expect(provider.getAccessToken({scopes: deployment.manifest.auth.teamsScopes})).resolves.toBe("teams-token")
    expect(native.acquireToken).toHaveBeenCalledWith(
      expect.any(Object),
      deployment.manifest.auth.teamsScopes,
      undefined,
    )

    await expect(provider.getAccessToken({scopes: ["api://attacker.example/admin"]})).rejects.toThrow("not declared")
  })

  it("refuses Teams tokens when the organization disables native meetings", async () => {
    const acquireToken = jest.fn(async () => {
      throw new Error("must not reach MSAL")
    })
    const native = {
      getAccount: jest.fn(async () => null),
      signIn: jest.fn(),
      acquireToken,
      signOut: jest.fn(async () => {}),
    } as unknown as ConstructorParameters<typeof MicrosoftEntraDeploymentAuthProvider>[1]
    const value = manifest()
    value.features = {...value.features, nativeMeetings: false}
    const deployment: OrganizationDeployment = {
      kind: "organization",
      source: "manual",
      organizationOrigin: ORGANIZATION,
      manifestUrl: `${ORGANIZATION}/.well-known/mentra-deployment.json`,
      manifest: value,
      activatedAt: new Date().toISOString(),
    }
    if (value.auth.mode !== "microsoft-entra") throw new Error("test requires Entra auth")

    const provider = new MicrosoftEntraDeploymentAuthProvider(deployment, native)
    await expect(provider.getAccessToken({scopes: value.auth.teamsScopes})).rejects.toThrow(
      "Native meetings are disabled by this deployment",
    )
    expect(acquireToken).not.toHaveBeenCalled()
  })
})

it("resolves the actual Enterprise reference manifest with preinstalled Call managed as userland", async () => {
  const origin = new URL(referenceManifest.services.runtimeUrl).origin
  const fetch = jest.fn(async () =>
    response(JSON.stringify(referenceManifest), {
      url: `${origin}/.well-known/mentra-deployment.json`,
    }),
  )
  const candidate = await resolveDeploymentCandidate(origin, {fetch})
  expect(candidate.manifest.miniapps.managed).toEqual(referenceManifest.miniapps.managed)
})

it("does not let an organization replace the build-selected Store", async () => {
  const value = manifest({
    miniapps: {
      configuration: {},
      managed: [
        {
          packageName: "com.mentra.store",
          version: "1.0.0",
          bundleUrl: `${ORGANIZATION}/miniapps/store.zip`,
          sha256: "a".repeat(64),
        },
      ],
    },
  })
  await expect(
    resolveDeploymentCandidate(ORGANIZATION, {fetch: async () => response(JSON.stringify(value))}),
  ).rejects.toMatchObject({code: "invalid-manifest"})
})
