import {describe, expect, test} from "bun:test"
import {createHmac} from "node:crypto"
import {
  parseForwardedPrincipal,
  signForwardedPrincipal,
  verifyForwardedPrincipal,
  type ForwardedRequest,
} from "./forwarded-principal"
import {SERVICE_HEADERS, signServiceRequest} from "./service-signature"
import {FORWARDED_PRINCIPAL_HEADERS, type ForwardedPrincipal} from "./types"

const SECRET = "fleet-secret"
const NOW = 1_760_000_000_000

const phone: ForwardedPrincipal = {
  kind: "phone",
  mentraUserId: "mu_1",
  tenantId: "mentra",
  sessionId: "sess_1",
  email: "phone@example.com",
}
const phoneWithoutEmail: ForwardedPrincipal = {...phone, email: null}
const user: ForwardedPrincipal = {
  kind: "user",
  mentraUserId: "mu_2",
  email: null,
  emailVerified: false,
  isOrganizationAdmin: true,
  organizationCapabilities: ["organization.fleet.administer", "organization.incidents.read"],
  scope: {kind: "organization"},
}
const workspaceUser: ForwardedPrincipal = {
  ...user,
  email: "admin@example.com",
  emailVerified: true,
  isOrganizationAdmin: false,
  organizationCapabilities: [],
  scope: {kind: "workspace", workspaceId: "ws_1"},
}

/** A request whose headers are a plain string map, so a test can add, drop or replace one. */
type SignedRequest = Omit<ForwardedRequest, "headers"> & {headers: Record<string, string>}

/** A request signed the way Core's forwarder signs it. */
function forwarded(
  principal: ForwardedPrincipal,
  options: {secret?: string; timestampMs?: number; method?: string; pathWithQuery?: string; body?: string} = {},
): SignedRequest {
  const secret = options.secret ?? SECRET
  const timestampMs = options.timestampMs ?? NOW
  const method = options.method ?? "POST"
  const pathWithQuery = options.pathWithQuery ?? "/v1/client/observations?batch=1"
  const body = options.body ?? '{"records":[]}'
  const signed = signForwardedPrincipal({secret, timestampMs, principal})
  return {
    method,
    pathWithQuery,
    body,
    headers: {
      [SERVICE_HEADERS.service]: "core",
      [SERVICE_HEADERS.timestamp]: String(timestampMs),
      [SERVICE_HEADERS.signature]: signServiceRequest({secret, method, pathWithQuery, body, timestampMs}),
      [FORWARDED_PRINCIPAL_HEADERS.principal]: signed.principal,
      [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: signed.principalSignature,
    },
  }
}

/** The same request with a different principal header, signed correctly by `secret` at `NOW`. */
function withSignedPrincipalBody(request: SignedRequest, body: unknown): SignedRequest {
  const header = Buffer.from(JSON.stringify(body)).toString("base64url")
  const signature = createHmac("sha256", SECRET).update(`${NOW}\n${header}`).digest("base64url")
  return {
    ...request,
    headers: {
      ...request.headers,
      [FORWARDED_PRINCIPAL_HEADERS.principal]: header,
      [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: signature,
    },
  }
}

const verify = (request: ForwardedRequest, secrets: readonly string[] = [SECRET], nowMs = NOW) =>
  verifyForwardedPrincipal(request, secrets, {nowMs})

describe("verifyForwardedPrincipal", () => {
  test("returns each principal kind Core signs", () => {
    expect(verify(forwarded(phone))).toEqual(phone)
    expect(verify(forwarded(phoneWithoutEmail))).toEqual(phoneWithoutEmail)
    expect(verify(forwarded(user))).toEqual(user)
    expect(verify(forwarded(workspaceUser))).toEqual(workspaceUser)
  })

  test("the principal header is base64url JSON and its signature is HMAC-SHA256 over `<ts>\\n<header>`", () => {
    const signed = signForwardedPrincipal({secret: SECRET, timestampMs: NOW, principal: phone})
    expect(Object.keys(signed).sort()).toEqual(["principal", "principalSignature"])
    expect(JSON.parse(Buffer.from(signed.principal, "base64url").toString())).toEqual(phone)
    expect(signed.principalSignature).toBe(
      createHmac("sha256", SECRET).update(`${NOW}\n${signed.principal}`).digest("base64url"),
    )
  })

  test("refuses to sign with an empty secret", () => {
    expect(() => signForwardedPrincipal({secret: "  ", timestampMs: NOW, principal: phone})).toThrow()
  })

  test("accepts a Headers object and any header-name case, and a rotated secret list", () => {
    const request = forwarded(user, {secret: "old"})
    expect(verify({...request, headers: new Headers(request.headers)}, ["new", "old"])).toEqual(user)
    const upper = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toUpperCase(), value]),
    )
    expect(verify({...request, headers: upper}, ["old"])).toEqual(user)
  })

  test("refuses a request whose service signature does not match what was received", () => {
    const request = forwarded(phone)
    expect(verify({...request, body: '{"records":[1]}'})).toBeNull()
    expect(verify({...request, pathWithQuery: "/v1/client/observations?batch=2"})).toBeNull()
    expect(verify({...request, method: "PUT"})).toBeNull()
    expect(verify(request, ["another-secret"])).toBeNull()
  })

  test("refuses a swapped principal or a principal signed for another timestamp", () => {
    const a = forwarded(phone)
    const b = forwarded(user)
    expect(
      verify({
        ...a,
        headers: {...a.headers, [FORWARDED_PRINCIPAL_HEADERS.principal]: b.headers[FORWARDED_PRINCIPAL_HEADERS.principal]!},
      }),
    ).toBeNull()
    expect(
      verify({
        ...a,
        headers: {
          ...a.headers,
          [FORWARDED_PRINCIPAL_HEADERS.principal]: b.headers[FORWARDED_PRINCIPAL_HEADERS.principal]!,
          [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: b.headers[FORWARDED_PRINCIPAL_HEADERS.principalSignature]!,
        },
      }),
    ).toEqual(user)
    const later = signForwardedPrincipal({secret: SECRET, timestampMs: NOW + 1, principal: phone})
    expect(
      verify({...a, headers: {...a.headers, [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: later.principalSignature}}),
    ).toBeNull()
  })

  test("a tampered principal fails even when its fields still parse", () => {
    const request = forwarded(workspaceUser)
    const escalated = Buffer.from(JSON.stringify({...workspaceUser, scope: {kind: "organization"}})).toString("base64url")
    expect(verify({...request, headers: {...request.headers, [FORWARDED_PRINCIPAL_HEADERS.principal]: escalated}})).toBeNull()
  })

  test("requires both signatures from the same secret", () => {
    const request = forwarded(phone, {secret: "s1"})
    const other = signForwardedPrincipal({secret: "s2", timestampMs: NOW, principal: phone})
    const mixed = {
      ...request,
      headers: {...request.headers, [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: other.principalSignature},
    }
    expect(verify(mixed, ["s1", "s2"])).toBeNull()
  })

  test("refuses a stale or future timestamp, honouring maxSkewMs", () => {
    const request = forwarded(phone)
    expect(verify(request, [SECRET], NOW + 61_000)).toBeNull()
    expect(verify(request, [SECRET], NOW - 61_000)).toBeNull()
    expect(verify(request, [SECRET], NOW + 30_000)).toEqual(phone)
    expect(verifyForwardedPrincipal(request, [SECRET], {nowMs: NOW + 30_000, maxSkewMs: 10_000})).toBeNull()
  })

  test("refuses a missing header, another service name, a malformed timestamp or blank secrets", () => {
    const request = forwarded(phone)
    for (const name of [
      SERVICE_HEADERS.service,
      SERVICE_HEADERS.timestamp,
      SERVICE_HEADERS.signature,
      FORWARDED_PRINCIPAL_HEADERS.principal,
      FORWARDED_PRINCIPAL_HEADERS.principalSignature,
    ]) {
      const headers = {...request.headers}
      delete headers[name]
      expect(verify({...request, headers})).toBeNull()
    }
    expect(verify({...request, headers: {...request.headers, [SERVICE_HEADERS.service]: "store"}})).toBeNull()
    expect(verify({...request, headers: {...request.headers, [SERVICE_HEADERS.timestamp]: `0${NOW}`}})).toBeNull()
    expect(verify({...request, headers: {...request.headers, [SERVICE_HEADERS.timestamp]: `${NOW}.0`}})).toBeNull()
    expect(verify(request, ["", "   "])).toBeNull()
    expect(verify(request, [])).toBeNull()
  })

  test("a repeated header counts as missing", () => {
    const request = forwarded(phone)
    const principal = request.headers[FORWARDED_PRINCIPAL_HEADERS.principal]!
    expect(
      verify({...request, headers: {...request.headers, [FORWARDED_PRINCIPAL_HEADERS.principal]: [principal, principal]}}),
    ).toBeNull()
  })

  test("refuses a correctly signed principal that is not one of the documented shapes", () => {
    const request = forwarded(phone)
    for (const body of [{kind: "admin", mentraUserId: "mu_1"}, {kind: "phone", mentraUserId: ""}, ["phone"]]) {
      expect(verify(withSignedPrincipalBody(request, body))).toBeNull()
    }
  })

  test("accepts a correctly signed principal from a newer Core that knows more capabilities and fields", () => {
    const newer = {
      ...user,
      organizationCapabilities: ["organization.fleet.administer", "organization.future.thing"],
      futureField: true,
      scope: {kind: "organization", futureDetail: 1},
    }
    expect(verify(withSignedPrincipalBody(forwarded(phone), newer))).toEqual({
      ...user,
      organizationCapabilities: ["organization.fleet.administer"],
    })
  })

  test("refuses a correctly signed credential principal", () => {
    const credential = {
      kind: "credential",
      credentialId: "01HZKEY",
      credentialKind: "workspace",
      workspaceId: "ws_1",
      scopes: ["miniapps.publish"],
      packageNames: ["com.example.app"],
    }
    expect(verify(withSignedPrincipalBody(forwarded(phone), credential))).toBeNull()
  })
})

describe("parseForwardedPrincipal", () => {
  test("accepts exactly the documented fields of each kind", () => {
    expect(parseForwardedPrincipal(phone)).toEqual(phone)
    expect(parseForwardedPrincipal(phoneWithoutEmail)).toEqual(phoneWithoutEmail)
    expect(parseForwardedPrincipal(user)).toEqual(user)
    expect(parseForwardedPrincipal(workspaceUser)).toEqual(workspaceUser)
  })

  test("returns a copy, not the object it was given", () => {
    const capabilities = ["organization.fleet.administer"]
    const input = {...user, organizationCapabilities: capabilities}
    const parsed = parseForwardedPrincipal(input)
    expect(parsed).toEqual(input as ForwardedPrincipal)
    expect(parsed).not.toBe(input)
    expect(parsed?.kind === "user" && parsed.organizationCapabilities).not.toBe(capabilities)
  })

  test("ignores fields the kind does not document and returns only the known ones", () => {
    const withExtra = parseForwardedPrincipal({...user, extra: "ignored"})
    expect(withExtra).toEqual(user)
    expect(Object.keys(withExtra!).sort()).toEqual(Object.keys(user).sort())
    const phoneWithExtra = parseForwardedPrincipal({...phone, extra: "ignored"})
    expect(phoneWithExtra).toEqual(phone)
    expect(Object.keys(phoneWithExtra!).sort()).toEqual(Object.keys(phone).sort())
    const organizationScope = parseForwardedPrincipal({...user, scope: {kind: "organization", workspaceId: "ws_1"}})
    expect(organizationScope).toEqual(user)
    expect(Object.keys((organizationScope as {scope: object}).scope)).toEqual(["kind"])
    const workspaceScope = parseForwardedPrincipal({...workspaceUser, scope: {kind: "workspace", workspaceId: "ws_1", extra: 1}})
    expect(workspaceScope).toEqual(workspaceUser)
    expect(Object.keys((workspaceScope as {scope: object}).scope).sort()).toEqual(["kind", "workspaceId"])
  })

  test("reads only a value's own properties, so a prototype can neither supply nor pollute a field", () => {
    const polluted = JSON.parse(
      '{"kind":"phone","mentraUserId":"mu_1","tenantId":"mentra","sessionId":"sess_1","email":null,"__proto__":{"kind":"user","isOrganizationAdmin":true}}',
    )
    const parsed = parseForwardedPrincipal(polluted)
    expect(parsed).toEqual({...phone, email: null})
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.keys(parsed!)).not.toContain("isOrganizationAdmin")
    expect(({} as Record<string, unknown>).isOrganizationAdmin).toBeUndefined()
    // Fields that exist only on the prototype do not count.
    expect(parseForwardedPrincipal(Object.create(phone))).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: Object.create({kind: "organization"})})).toBeNull()
  })

  test("refuses fields of the wrong type", () => {
    expect(parseForwardedPrincipal({...user, emailVerified: "yes"})).toBeNull()
    expect(parseForwardedPrincipal({...user, email: 7})).toBeNull()
    expect(parseForwardedPrincipal({...user, isOrganizationAdmin: 1})).toBeNull()
    expect(parseForwardedPrincipal({...phone, sessionId: null})).toBeNull()
    expect(parseForwardedPrincipal({...phone, tenantId: 1})).toBeNull()
    expect(parseForwardedPrincipal({...phone, email: 7})).toBeNull()
    expect(parseForwardedPrincipal({...phone, mentraUserId: " "})).toBeNull()
    expect(parseForwardedPrincipal(null)).toBeNull()
    expect(parseForwardedPrincipal("phone")).toBeNull()
    expect(parseForwardedPrincipal([phone])).toBeNull()
  })

  test("a phone principal needs its email field, null or a string", () => {
    const {email: _email, ...withoutEmail} = phone as Extract<ForwardedPrincipal, {kind: "phone"}>
    expect(parseForwardedPrincipal(withoutEmail)).toBeNull()
    expect(parseForwardedPrincipal({...phone, email: null})).toEqual(phoneWithoutEmail)
  })

  test("a credential-shaped principal is not a principal", () => {
    expect(
      parseForwardedPrincipal({
        kind: "credential",
        credentialId: "01HZKEY",
        credentialKind: "workspace",
        workspaceId: "ws_1",
        scopes: ["miniapps.publish"],
        packageNames: ["com.example.app"],
      }),
    ).toBeNull()
  })

  test("a user principal needs a known scope", () => {
    const {scope: _scope, ...withoutScope} = user as Extract<ForwardedPrincipal, {kind: "user"}>
    expect(parseForwardedPrincipal(withoutScope)).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: null})).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: "organization"})).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: {kind: "team"}})).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: {}})).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: {kind: "workspace"}})).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: {kind: "workspace", workspaceId: ""}})).toBeNull()
    expect(parseForwardedPrincipal({...user, scope: {kind: "workspace", workspaceId: 7}})).toBeNull()
  })

  test("a phone principal that carries organizationCapabilities or a scope is a phone principal without them", () => {
    for (const extra of [
      {organizationCapabilities: []},
      {organizationCapabilities: ["organization.fleet.administer"]},
      {scope: {kind: "organization"}},
    ]) {
      const parsed = parseForwardedPrincipal({...phone, ...extra})
      expect(parsed).toEqual(phone)
      expect(Object.keys(parsed!)).not.toContain("organizationCapabilities")
      expect(Object.keys(parsed!)).not.toContain("scope")
    }
  })

  test("a user principal needs an organizationCapabilities array of strings, and drops the ones it does not know", () => {
    const {organizationCapabilities: _caps, ...withoutCapabilities} = user as Extract<ForwardedPrincipal, {kind: "user"}>
    expect(parseForwardedPrincipal(withoutCapabilities)).toBeNull()
    expect(parseForwardedPrincipal({...user, organizationCapabilities: "organization.fleet.administer"})).toBeNull()
    expect(parseForwardedPrincipal({...user, organizationCapabilities: null})).toBeNull()
    expect(parseForwardedPrincipal({...user, organizationCapabilities: [7]})).toBeNull()
    expect(parseForwardedPrincipal({...user, organizationCapabilities: ["organization.fleet.administer", null]})).toBeNull()
    expect(parseForwardedPrincipal({...user, organizationCapabilities: []})).toEqual({...user, organizationCapabilities: []})
    // A capability this build does not know is dropped, not a reason to refuse the person.
    expect(
      parseForwardedPrincipal({
        ...user,
        organizationCapabilities: ["organization.future.thing", "organization.fleet.administer", "workspace.read"],
      }),
    ).toEqual({...user, organizationCapabilities: ["organization.fleet.administer"]})
    expect(parseForwardedPrincipal({...user, organizationCapabilities: ["organization.future.thing"]})).toEqual({
      ...user,
      organizationCapabilities: [],
    })
  })
})
