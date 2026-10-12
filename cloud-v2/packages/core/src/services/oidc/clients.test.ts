import {afterEach, describe, expect, test} from "bun:test"

import {ConfigurationError} from "../signin/config"
import {
  assertClientConfiguration,
  clientOfKind,
  configuredClients,
  findClient,
  providerClientMetadata,
} from "./clients"

const NAMES = [
  "CLOUD_CORE_OIDC_CLIENTS",
  "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
  "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET",
  "CLOUD_CORE_ENVIRONMENT",
  "NODE_ENV",
] as const
const saved = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const SECRET = "s".repeat(40)
const admin = {
  clientId: "mentra-admin-dev",
  kind: "admin_portal",
  secretEnv: "CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET",
  redirectUris: ["https://admin.dev.mentraglass.com/api/admin/auth/callback"],
}
const cli = {clientId: "mentra-cli-dev", kind: "cli", redirectUris: ["http://127.0.0.1:53682/callback", "http://127.0.0.1:53683/callback"]}

function configure(clients: unknown, env: Record<string, string | undefined> = {}) {
  process.env.CLOUD_CORE_OIDC_CLIENTS = typeof clients === "string" ? clients : JSON.stringify(clients)
  process.env.CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET = SECRET
  process.env.CLOUD_CORE_ENVIRONMENT = "dev"
  delete process.env.NODE_ENV
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

describe("first-party client registry", () => {
  test("parses confidential and public clients", async () => {
    configure([admin, cli])
    expect(configuredClients().map(client => [client.clientId, client.kind, client.confidential, client.firstParty])).toEqual([
      ["mentra-admin-dev", "admin_portal", true, true],
      ["mentra-cli-dev", "cli", false, true],
    ])
    expect(clientOfKind("admin_portal")?.clientId).toBe("mentra-admin-dev")
    expect((await findClient("mentra-admin-dev"))?.name).toBe("Mentra admin portal")
    expect(await findClient("someone-else")).toBeNull()
    expect(() => assertClientConfiguration()).not.toThrow()
  })

  test("provider metadata: client_secret_post for confidential clients, none and native for the CLI; refresh only for the Console and CLI", () => {
    configure([admin, cli, {clientId: "console", kind: "console", secretEnv: "CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET", redirectUris: ["https://console.mentraglass.com/api/console/auth/callback"]}], {
      CLOUD_CORE_OIDC_CONSOLE_CLIENT_SECRET: SECRET,
    })
    const [adminClient, cliClient, consoleClient] = configuredClients()
    expect(providerClientMetadata(adminClient!)).toMatchObject({
      client_secret: SECRET,
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      application_type: "web",
      id_token_signed_response_alg: "EdDSA",
    })
    expect(providerClientMetadata(cliClient!)).toMatchObject({token_endpoint_auth_method: "none", application_type: "native", grant_types: ["authorization_code", "refresh_token"]})
    expect(providerClientMetadata(cliClient!).client_secret).toBeUndefined()
    expect(providerClientMetadata(consoleClient!).grant_types).toEqual(["authorization_code", "refresh_token"])
  })

  test("a confidential client whose secret is unset is unknown, and refused at startup", async () => {
    configure([admin], {CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: undefined})
    expect(await findClient("mentra-admin-dev")).toBeNull()
    expect(() => assertClientConfiguration()).toThrow("CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET, which is not set")
  })

  test("a short secret is refused at startup", () => {
    configure([admin], {CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET: "short"})
    expect(() => assertClientConfiguration()).toThrow("at least 32 characters")
  })

  test.each([
    ["not JSON", "{", "JSON array"],
    ["an object", {clientId: "x"}, "JSON array"],
    ["a bad client ID", [{...admin, clientId: "a b"}], "clientId"],
    ["an unknown kind", [{...admin, kind: "miniapp_website"}], "kind must be one of"],
    ["a duplicate client ID", [admin, {...admin, kind: "workspace_portal"}], "listed twice"],
    ["two clients of one kind", [admin, {...admin, clientId: "other"}], "at most one client of kind admin_portal"],
    ["a secret variable outside the contract's names", [{...admin, secretEnv: "DATABASE_PASSWORD"}], "CLOUD_CORE_OIDC_<CLIENT>_CLIENT_SECRET"],
    ["a confidential client without secretEnv", [{...admin, secretEnv: undefined}], "secretEnv"],
    ["a public client with a secret", [{...cli, secretEnv: "CLOUD_CORE_OIDC_CLI_CLIENT_SECRET"}], "public client"],
    ["no redirect URIs", [{...admin, redirectUris: []}], "non-empty array"],
    ["an HTTP redirect URI", [{...admin, redirectUris: ["http://admin.example.com/cb"]}], "must be an HTTPS URL"],
    ["a redirect URI with a fragment", [{...admin, redirectUris: ["https://admin.example.com/cb#x"]}], "no fragment"],
    ["a CLI redirect off the loopback", [{...cli, redirectUris: ["https://cli.example.com/callback"]}], "loopback"],
  ] as const)("refuses %s", (_label, clients, message) => {
    configure(clients)
    expect(() => configuredClients()).toThrow(ConfigurationError)
    expect(() => configuredClients()).toThrow(message)
  })

  test("a loopback HTTP redirect for a web client is allowed only on an undeployed Core", () => {
    configure([{...admin, redirectUris: ["http://127.0.0.1:4001/api/admin/auth/callback"]}])
    expect(() => configuredClients()).toThrow("must be an HTTPS URL")
    configure([{...admin, redirectUris: ["http://127.0.0.1:4001/api/admin/auth/callback"]}], {CLOUD_CORE_ENVIRONMENT: undefined})
    expect(configuredClients()).toHaveLength(1)
  })
})
