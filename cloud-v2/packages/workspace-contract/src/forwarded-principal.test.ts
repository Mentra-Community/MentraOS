import {describe, expect, test} from "bun:test"
import {createHmac} from "node:crypto"
import {parseForwardedPrincipal, signForwardedPrincipal, verifyForwardedPrincipal, type ForwardedRequest} from "./forwarded-principal"
import {SERVICE_HEADERS, signServiceRequest} from "./service-signature"
import {FORWARDED_PRINCIPAL_HEADERS, type ForwardedPrincipal} from "./types"

const SECRET = "fleet-secret"
const NOW = 1_760_000_000_000

const phone: ForwardedPrincipal = {kind: "phone", mentraUserId: "mu_1", tenantId: "mentra", sessionId: "sess_1"}
const user: ForwardedPrincipal = {
  kind: "user",
  mentraUserId: "mu_2",
  email: null,
  emailVerified: false,
  isOrganizationAdmin: true,
}
const credential: ForwardedPrincipal = {
  kind: "credential",
  credentialId: "01HZKEY",
  credentialKind: "workspace",
  workspaceId: "ws_1",
  scopes: ["miniapps.publish"],
  packageNames: ["com.example.app"],
}

/** A request signed the way Core's forwarder signs it. */
function forwarded(
  principal: ForwardedPrincipal,
  options: {secret?: string; timestampMs?: number; method?: string; pathWithQuery?: string; body?: string} = {},
): ForwardedRequest & {headers: Record<string, string>} {
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
      [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: signed.signature,
    },
  }
}

const verify = (request: ForwardedRequest, secrets: readonly string[] = [SECRET], nowMs = NOW) =>
  verifyForwardedPrincipal(request, secrets, {nowMs})

describe("verifyForwardedPrincipal", () => {
  test("returns each principal kind Core signs", () => {
    expect(verify(forwarded(phone))).toEqual(phone)
    expect(verify(forwarded(user))).toEqual(user)
    expect(verify(forwarded(credential))).toEqual(credential)
  })

  test("the principal header is base64url JSON and its signature is HMAC-SHA256 over `<ts>\\n<header>`", () => {
    const signed = signForwardedPrincipal({secret: SECRET, timestampMs: NOW, principal: phone})
    expect(JSON.parse(Buffer.from(signed.principal, "base64url").toString())).toEqual(phone)
    expect(signed.signature).toBe(createHmac("sha256", SECRET).update(`${NOW}\n${signed.principal}`).digest("base64url"))
  })

  test("accepts a Headers object and any header-name case, and a rotated secret list", () => {
    const request = forwarded(user, {secret: "old"})
    expect(verify({...request, headers: new Headers(request.headers)}, ["new", "old"])).toEqual(user)
    const upper = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toUpperCase(), value]))
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
      verify({...a, headers: {...a.headers, [FORWARDED_PRINCIPAL_HEADERS.principal]: b.headers[FORWARDED_PRINCIPAL_HEADERS.principal]!}}),
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
      verify({...a, headers: {...a.headers, [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: later.signature}}),
    ).toBeNull()
  })

  test("requires both signatures from the same secret", () => {
    const request = forwarded(phone, {secret: "s1"})
    const other = signForwardedPrincipal({secret: "s2", timestampMs: NOW, principal: phone})
    const mixed = {...request, headers: {...request.headers, [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: other.signature}}
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
    expect(verify({...request, headers: {...request.headers, [FORWARDED_PRINCIPAL_HEADERS.principal]: [principal, principal]}})).toBeNull()
  })

  test("refuses a correctly signed principal that is not one of the documented shapes", () => {
    for (const body of [{kind: "admin", mentraUserId: "mu_1"}, {kind: "phone", mentraUserId: ""}, ["phone"]]) {
      const header = Buffer.from(JSON.stringify(body)).toString("base64url")
      const request = forwarded(phone)
      const signature = createHmac("sha256", SECRET).update(`${NOW}\n${header}`).digest("base64url")
      expect(
        verify({
          ...request,
          headers: {
            ...request.headers,
            [FORWARDED_PRINCIPAL_HEADERS.principal]: header,
            [FORWARDED_PRINCIPAL_HEADERS.principalSignature]: signature,
          },
        }),
      ).toBeNull()
    }
  })
})

describe("parseForwardedPrincipal", () => {
  test("keeps only the documented fields", () => {
    expect(parseForwardedPrincipal({...user, extra: "dropped"})).toEqual(user)
    expect(parseForwardedPrincipal({...credential, label: "ci key"})).toEqual(credential)
  })

  test("refuses fields of the wrong type", () => {
    expect(parseForwardedPrincipal({...user, emailVerified: "yes"})).toBeNull()
    expect(parseForwardedPrincipal({...user, email: 7})).toBeNull()
    expect(parseForwardedPrincipal({...credential, credentialKind: "service"})).toBeNull()
    expect(parseForwardedPrincipal({...credential, scopes: "miniapps.publish"})).toBeNull()
    expect(parseForwardedPrincipal({...credential, packageNames: [1]})).toBeNull()
    expect(parseForwardedPrincipal({...phone, sessionId: null})).toBeNull()
    expect(parseForwardedPrincipal(null)).toBeNull()
  })
})
