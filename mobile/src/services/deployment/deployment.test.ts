import {DeploymentResolutionError, normalizeWorkspaceOrigin, resolveDeploymentCandidate} from "./resolver"
import {DeploymentStore, type DeploymentStorage} from "./store"
import type {ActiveDeployment, DeploymentManifest, WorkspaceDeployment} from "./types"
import {MicrosoftEntraDeploymentAuthProvider} from "./auth/MicrosoftEntraDeploymentAuthProvider"

const WORKSPACE = "https://mentra.enterprise.example"

function manifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    schemaVersion: 1,
    deploymentId: "mentra-enterprise-dev",
    displayName: "Mentra Enterprise Dev",
    branding: {
      logoUrls: {
        light: `${WORKSPACE}/branding/logo-light.png`,
        dark: `${WORKSPACE}/branding/logo-dark.png`,
      },
    },
    services: {coreUrl: WORKSPACE, runtimeUrl: WORKSPACE},
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
      mentraLiveOtaManifestUrl: `${WORKSPACE}/artifacts/mentra-live/version.json`,
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
      privacyPolicyUrl: `${WORKSPACE}/privacy`,
      termsOfServiceUrl: `${WORKSPACE}/terms`,
      documentationUrl: `${WORKSPACE}/docs`,
      supportUrl: `${WORKSPACE}/support`,
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
    url: options.url ?? `${WORKSPACE}/.well-known/mentra-deployment.json`,
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

describe("normalizeWorkspaceOrigin", () => {
  it.each([
    "mentra.enterprise.example/",
    "https://mentra.enterprise.example/path/to/a/homepage",
    "https://mentra.enterprise.example/.well-known/mentra-deployment.json",
    "https://mentra.enterprise.example?workspace=example#sign-in",
  ])("normalizes a user-provided organization address %s", (input) => {
    expect(normalizeWorkspaceOrigin(input)).toBe(WORKSPACE)
  })

  it.each([
    "http://mentra.enterprise.example",
    "https://user:password@mentra.enterprise.example",
    "ftp://mentra.enterprise.example",
  ])("rejects unsafe workspace input %s", (input) => {
    expect(() => normalizeWorkspaceOrigin(input)).toThrow(DeploymentResolutionError)
  })
})

describe("resolveDeploymentCandidate", () => {
  it("resolves and validates a customer manifest", async () => {
    const fetch = jest.fn(async () => response(JSON.stringify(manifest())))
    const candidate = await resolveDeploymentCandidate(WORKSPACE, {fetch})

    expect(candidate.workspaceOrigin).toBe(WORKSPACE)
    expect(candidate.manifest.auth.mode).toBe("microsoft-entra")
    expect(candidate.manifest.branding?.logoUrls.light).toBe(`${WORKSPACE}/branding/logo-light.png`)
    expect(fetch).toHaveBeenCalledWith(
      `${WORKSPACE}/.well-known/mentra-deployment.json`,
      expect.objectContaining({redirect: "manual"}),
    )
  })

  it("defaults older schema-v1 manifests to no managed userland miniapps", async () => {
    const {miniapps: _managedMiniapps, ...value} = manifest()
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).resolves.toMatchObject({
      manifest: {miniapps: {managed: [], configuration: {}}},
    })
  })

  it("rejects cross-origin Runtime", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(manifest({services: {coreUrl: WORKSPACE, runtimeUrl: "https://runtime.attacker.example"}})),
      ),
    )
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "origin-mismatch"})
  })

  it("rejects a workspace without Core", async () => {
    const fetch = jest.fn(async () =>
      response(JSON.stringify(manifest({services: {coreUrl: null, runtimeUrl: WORKSPACE}}))),
    )
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects a cross-origin workspace logo", async () => {
    const fetch = jest.fn(async () =>
      response(
        JSON.stringify(
          manifest({
            branding: {
              logoUrls: {
                light: "https://images.attacker.example/logo.png",
                dark: `${WORKSPACE}/branding/logo-dark.png`,
              },
            },
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "origin-mismatch"})
  })

  it("accepts same-origin manifest-managed userland miniapps", async () => {
    const value = manifest({
      miniapps: {
        managed: [
          {
            packageName: "com.example.remoteassist",
            version: "1.2.0",
            bundleUrl: `${WORKSPACE}/miniapps/remote-assist-1.2.0.zip`,
            sha256: "a".repeat(64),
          },
        ],
        configuration: {},
      },
    })
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).resolves.toMatchObject({manifest: value})
  })

  it("accepts package-scoped miniapp configuration for an approved package", async () => {
    const value = manifest({
      systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.settings"]},
      miniapps: {
        managed: [],
        configuration: {
          "com.mentra.settings": {backendUrl: `${WORKSPACE}/settings-api`},
        },
      },
    })
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).resolves.toMatchObject({manifest: value})
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
                "com.example.unapproved": {backendUrl: `${WORKSPACE}/unapproved-api`},
              },
            },
          }),
        ),
      ),
    )

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
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

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects cross-origin, duplicate, and SYSTEM-overlapping managed miniapps", async () => {
    const entry = {
      packageName: "com.example.remoteassist",
      version: "1.2.0",
      bundleUrl: `${WORKSPACE}/miniapps/remote-assist-1.2.0.zip`,
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
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: crossOriginFetch})).rejects.toMatchObject({
      code: "origin-mismatch",
    })

    const duplicateFetch = jest.fn(async () =>
      response(JSON.stringify(manifest({miniapps: {managed: [entry, {...entry}], configuration: {}}}))),
    )
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: duplicateFetch})).rejects.toMatchObject({
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
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: overlapFetch})).rejects.toMatchObject({
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
                  bundleUrl: `${WORKSPACE}/miniapps/settings-1.2.0.zip`,
                  sha256: "a".repeat(64),
                },
              ],
              configuration: {},
            },
          }),
        ),
      ),
    )
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it.each(["v1.2.3", "1.2", "1.2.3-01"])("rejects non-canonical managed version %s", async (version) => {
    const value = manifest({
      miniapps: {
        managed: [
          {
            packageName: "com.example.remoteassist",
            version,
            bundleUrl: `${WORKSPACE}/miniapps/remote-assist.zip`,
            sha256: "a".repeat(64),
          },
        ],
        configuration: {},
      },
    })
    await expect(
      resolveDeploymentCandidate(WORKSPACE, {fetch: async () => response(JSON.stringify(value))}),
    ).rejects.toMatchObject({
      code: "invalid-manifest",
    })
  })

  it("rejects query-bearing Core and Runtime base URLs", async () => {
    const value = manifest({services: {coreUrl: `${WORKSPACE}?core=1`, runtimeUrl: WORKSPACE}})
    await expect(
      resolveDeploymentCandidate(WORKSPACE, {fetch: async () => response(JSON.stringify(value))}),
    ).rejects.toMatchObject({
      code: "invalid-manifest",
    })
  })

  it("rejects redirects and oversized responses", async () => {
    const redirectFetch = jest.fn(async () => response("", {status: 302}))
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: redirectFetch})).rejects.toMatchObject({
      code: "redirect",
    })

    const largeFetch = jest.fn(async () => response("{}", {contentLength: 500_000}))
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: largeFetch})).rejects.toMatchObject({
      code: "response-too-large",
    })

    const streamedLargeFetch = jest.fn(async () => response("x".repeat(300_000)))
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: streamedLargeFetch})).rejects.toMatchObject({
      code: "response-too-large",
    })
  })

  it("fails closed when a custom fetch does not expose a streaming body", async () => {
    const unstreamed = response(JSON.stringify(manifest()), {streamed: false})
    unstreamed.text = jest.fn()
    const fetch = jest.fn(async () => unstreamed)

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({
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
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch: async () => malformed})).rejects.toMatchObject({
      code: "invalid-manifest",
      message: "Workspace manifest body is not valid UTF-8.",
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
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("rejects workspace auth modes not implemented by this release", async () => {
    const fetch = jest.fn(async () => response(JSON.stringify(manifest({auth: {mode: "mentra-account"}}))))
    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })

  it("requires the fixed ACS Teams scope pair for native meetings", async () => {
    const value = manifest()
    if (value.auth.mode !== "microsoft-entra") throw new Error("test requires Entra auth")
    value.auth.teamsScopes = ["https://auth.msft.communication.azure.com/Teams.ManageCalls"]
    const fetch = jest.fn(async () => response(JSON.stringify(value)))

    await expect(resolveDeploymentCandidate(WORKSPACE, {fetch})).rejects.toMatchObject({code: "invalid-manifest"})
  })
})

class MemoryDeploymentStorage implements DeploymentStorage {
  value: ActiveDeployment | null = null

  load(): unknown | null {
    return this.value
  }

  save(value: ActiveDeployment): void {
    this.value = value
  }

  remove(): void {
    this.value = null
  }
}

describe("DeploymentStore", () => {
  it("starts unresolved and persists an explicit Mentra or workspace selection", () => {
    const persistence = new MemoryDeploymentStorage()
    const store = new DeploymentStore(persistence)
    expect(store.getActive()).toEqual({kind: "consumer", source: "embedded"})
    expect(store.isResolved()).toBe(false)
    expect(store.isTelemetryAllowed()).toBe(false)

    store.activate({
      workspaceOrigin: WORKSPACE,
      manifestUrl: `${WORKSPACE}/.well-known/mentra-deployment.json`,
      manifest: manifest(),
    })
    expect(new DeploymentStore(persistence).getActive()).toMatchObject({
      kind: "workspace",
      workspaceOrigin: WORKSPACE,
    })
    expect(store.isTelemetryAllowed()).toBe(false)

    store.returnToMentra()
    expect(store.getActive()).toEqual({kind: "consumer", source: "embedded"})
    expect(store.isResolved()).toBe(true)
    expect(store.isTelemetryAllowed()).toBe(true)
    expect(new DeploymentStore(persistence).isResolved()).toBe(true)

    store.clearSelection()
    expect(store.isResolved()).toBe(false)
    expect(store.isTelemetryAllowed()).toBe(false)
  })

  it("fails closed to consumer for malformed persisted data", () => {
    const persistence = new MemoryDeploymentStorage()
    persistence.value = {kind: "workspace"} as WorkspaceDeployment
    expect(new DeploymentStore(persistence).getActive()).toEqual({kind: "consumer", source: "embedded"})
    expect(new DeploymentStore(persistence).isResolved()).toBe(false)
  })

  it("fails closed when a persisted manifest violates cross-field validation", () => {
    const persistence = new MemoryDeploymentStorage()
    persistence.value = {
      kind: "workspace",
      source: "manual",
      workspaceOrigin: WORKSPACE,
      manifestUrl: `${WORKSPACE}/.well-known/mentra-deployment.json`,
      manifest: manifest({services: {coreUrl: WORKSPACE, runtimeUrl: "https://attacker.example"}}),
      activatedAt: new Date().toISOString(),
    }
    const store = new DeploymentStore(persistence)
    expect(store.getActive()).toEqual({kind: "consumer", source: "embedded"})
    expect(store.isResolved()).toBe(false)
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
    const deployment: WorkspaceDeployment = {
      kind: "workspace",
      source: "manual",
      workspaceOrigin: WORKSPACE,
      manifestUrl: `${WORKSPACE}/.well-known/mentra-deployment.json`,
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

  it("refuses Teams tokens when the workspace disables native meetings", async () => {
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
    const deployment: WorkspaceDeployment = {
      kind: "workspace",
      source: "manual",
      workspaceOrigin: WORKSPACE,
      manifestUrl: `${WORKSPACE}/.well-known/mentra-deployment.json`,
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
