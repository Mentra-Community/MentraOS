import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import {
  createMiniappFetcher,
  fetchMiniappManifest,
  mentraChallengePackage,
  MINIAPP_FETCH_MAX_BYTES,
  MINIAPP_FETCH_MAX_REDIRECTS,
  MINIAPP_FETCH_TIMEOUT_MS,
  type MiniappFetcherConfig,
} from "./miniapp-fetcher"

// Public addresses the test resolver answers; the dialler routes them to the
// local TLS server. Nothing here leaves the machine.
const PUBLIC_A = "93.184.215.14"
const PUBLIC_B = "93.184.215.15"
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c"
const HANGING = "93.184.215.99"
const MANIFEST = JSON.stringify({packageName: "com.example.notes", version: "1.0.0", name: "Notes"})

interface SeenRequest {
  requestLine: string
  headers: Record<string, string>
  raw: string
}

type Handler = (request: SeenRequest, socket: tls.TLSSocket) => void

let certificate: {cert: string; key: string}
let server: tls.Server
let serverPort = 0
let hangingServer: net.Server
let hangingPort = 0
let closedPort = 0
let handler: Handler = (_request, socket) => respond(socket, 200, {"Content-Type": "application/json"}, MANIFEST)
let requests: SeenRequest[] = []
let dialed: string[] = []
let resolved: string[] = []

/** A self-signed certificate for the test hosts, made per run so no key lives in the repository. */
function makeCertificate(): {cert: string; key: string} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miniapp-fetcher-"))
  try {
    const config = [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      "CN = miniapp.example.com",
      "[v3]",
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, digitalSignature, keyCertSign",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = DNS:miniapp.example.com, DNS:other.example.com, IP:${PUBLIC_A}`,
      "",
    ].join("\n")
    fs.writeFileSync(path.join(dir, "openssl.cnf"), config)
    const result = Bun.spawnSync(
      [
        "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        // LibreSSL otherwise writes explicit curve parameters, which BoringSSL refuses.
        "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-days", "2",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-config", path.join(dir, "openssl.cnf"),
      ],
      {stdin: "ignore", timeout: 30_000},
    )
    if (result.exitCode !== 0) throw new Error(`openssl could not make the test certificate: ${result.stderr.toString()}`)
    return {cert: fs.readFileSync(path.join(dir, "cert.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "key.pem"), "utf8")}
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
}

function listen(target: net.Server): Promise<number> {
  return new Promise(resolve => target.listen(0, "127.0.0.1", () => resolve((target.address() as net.AddressInfo).port)))
}

function respond(socket: tls.TLSSocket, status: number, headers: Record<string, string>, body = "") {
  const lines = [`HTTP/1.1 ${status} Status`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)]
  if (!Object.keys(headers).some(name => name.toLowerCase() === "transfer-encoding")) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
  socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`)
}

function redirect(socket: tls.TLSSocket, location: string, status = 302) {
  respond(socket, status, {Location: location})
}

beforeAll(async () => {
  certificate = makeCertificate()
  server = tls.createServer({cert: certificate.cert, key: certificate.key}, socket => {
    let buffered = ""
    let handled = false
    socket.on("data", chunk => {
      if (handled) return
      buffered += chunk.toString("latin1")
      const end = buffered.indexOf("\r\n\r\n")
      if (end === -1) return
      handled = true
      const [requestLine = "", ...headerLines] = buffered.slice(0, end).split("\r\n")
      const headers: Record<string, string> = {}
      for (const line of headerLines) {
        const colon = line.indexOf(":")
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
      }
      const request = {requestLine, headers, raw: buffered.slice(0, end)}
      requests.push(request)
      handler(request, socket)
    })
    socket.on("error", () => {})
  })
  serverPort = await listen(server)
  hangingServer = net.createServer(() => {})
  hangingPort = await listen(hangingServer)
  const closed = net.createServer()
  closedPort = await listen(closed)
  await new Promise(resolve => closed.close(resolve))
})

afterAll(() => {
  server.close()
  hangingServer.close()
})

beforeEach(() => {
  handler = (_request, socket) => respond(socket, 200, {"Content-Type": "application/json", ETag: '"v1"'}, MANIFEST)
  requests = []
  dialed = []
  resolved = []
})

type DnsAnswer = string[] | (() => string[]) | Error

/** A fetcher whose resolver answers from `table` and whose dialler records each address. */
function fetcher(table: Record<string, DnsAnswer>, config: MiniappFetcherConfig = {}) {
  return createMiniappFetcher({
    resolve: async host => {
      resolved.push(host)
      const answer = table[host]
      if (answer === undefined) throw Object.assign(new Error(`${host} not found`), {code: "ENOTFOUND"})
      if (answer instanceof Error) throw answer
      return typeof answer === "function" ? answer() : answer
    },
    dial: address => {
      dialed.push(address)
      if (address === HANGING) return {host: "127.0.0.1", port: hangingPort}
      if (address === PUBLIC_A || address === PUBLIC_V6) return {host: "127.0.0.1", port: serverPort}
      return {host: "127.0.0.1", port: closedPort}
    },
    ca: certificate.cert,
    ...config,
  })
}

const exampleDns = {"miniapp.example.com": [PUBLIC_A], "other.example.com": [PUBLIC_A]}

describe("fetchMiniappManifest", () => {
  test("reads miniapp.json from the checked address, with the host for SNI, the certificate and Host", async () => {
    const result = await fetcher(exampleDns)("https://miniapp.example.com/notes/")
    expect(result).toEqual({
      kind: "ok",
      manifest: {finalUrl: "https://miniapp.example.com/notes/miniapp.json", status: 200, body: MANIFEST, etag: '"v1"'},
    })
    expect(resolved).toEqual(["miniapp.example.com"])
    expect(dialed).toEqual([PUBLIC_A])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.requestLine).toBe("GET /notes/miniapp.json HTTP/1.1")
    expect(requests[0]!.headers).toEqual({
      host: "miniapp.example.com",
      "user-agent": "Mentra-Core (miniapp registry)",
      accept: "application/json",
      "accept-encoding": "identity",
      connection: "close",
    })
  })

  test("adds the trailing slash to a URL without one, and drops its query and fragment", async () => {
    const result = await fetcher(exampleDns)("https://miniapp.example.com/notes?x=1#top")
    expect(result.kind).toBe("ok")
    expect(requests[0]!.requestLine).toBe("GET /notes/miniapp.json HTTP/1.1")
  })

  test("refuses a URL that isn't HTTPS on port 443 before resolving or connecting", async () => {
    const fetch = fetcher(exampleDns)
    for (const url of [
      "http://miniapp.example.com/",
      "https://miniapp.example.com:8443/",
      "https://miniapp.example.com:80/",
      "https://user:secret@miniapp.example.com/",
      "https://user@miniapp.example.com/",
      "ftp://miniapp.example.com/",
      "wss://miniapp.example.com/",
      "not a url",
      "",
    ]) {
      expect({url, result: await fetch(url)}).toEqual({url, result: {kind: "unreachable", reason: "bad_url"}})
    }
    expect(resolved).toEqual([])
    expect(dialed).toEqual([])
  })

  test("an explicit :443 is the default port", async () => {
    expect((await fetcher(exampleDns)("https://miniapp.example.com:443/")).kind).toBe("ok")
  })

  test("answers dns when the host doesn't resolve or has no addresses", async () => {
    expect(await fetcher({})("https://missing.example.com/")).toEqual({kind: "unreachable", reason: "dns"})
    expect(await fetcher({"empty.example.com": []})("https://empty.example.com/")).toEqual({kind: "unreachable", reason: "dns"})
    expect(dialed).toEqual([])
  })

  test("refuses a host with any private or internal answer, without connecting", async () => {
    for (const answers of [
      ["127.0.0.1"],
      ["10.0.0.5"],
      ["169.254.169.254"],
      ["100.64.0.1"],
      ["::1"],
      ["::ffff:127.0.0.1"],
      ["::ffff:7f00:1"],
      ["fd00:ec2::254"],
      ["fe80::1"],
      ["64:ff9b::a00:5"],
      ["2002:a00:5::1"],
      ["2001::1"],
      ["0.0.0.0"],
      [PUBLIC_A, "10.0.0.5"],
      ["10.0.0.5", PUBLIC_A],
      [PUBLIC_V6, "::ffff:192.168.1.1"],
    ]) {
      const result = await fetcher({"miniapp.example.com": answers})("https://miniapp.example.com/")
      expect({answers, result}).toEqual({answers, result: {kind: "unreachable", reason: "private_address"}})
    }
    expect(dialed).toEqual([])
    expect(requests).toEqual([])
  })

  test("refuses private address literals in the URL without resolving", async () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://169.254.169.254/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[fd00:ec2::254]/",
      "https://0.0.0.0/",
      "https://2130706433/",
      "https://0x7f.1/",
      "https://localhost/",
    ]) {
      const result = await fetcher({localhost: ["127.0.0.1", "::1"]})(url)
      expect({url, result}).toEqual({url, result: {kind: "unreachable", reason: "private_address"}})
    }
    expect(resolved).toEqual(["localhost"])
    expect(dialed).toEqual([])
  })

  test("a public address literal is checked against the certificate's IP names", async () => {
    const result = await fetcher({})(`https://${PUBLIC_A}/`)
    expect(result.kind).toBe("ok")
    expect(resolved).toEqual([])
    expect(requests[0]!.headers.host).toBe(PUBLIC_A)
  })

  test("a second DNS answer can't move the connection: it goes to the address that was checked", async () => {
    let calls = 0
    const rebinding = () => (calls++ === 0 ? [PUBLIC_A] : ["127.0.0.1"])
    const result = await fetcher({"miniapp.example.com": rebinding})("https://miniapp.example.com/")
    expect(result.kind).toBe("ok")
    expect(calls).toBe(1)
    expect(dialed).toEqual([PUBLIC_A])
  })

  test("a redirect back to a host that now resolves to loopback is refused", async () => {
    let calls = 0
    const rebinding = () => (calls++ === 0 ? [PUBLIC_A] : ["127.0.0.1"])
    handler = (_request, socket) => redirect(socket, "/again/miniapp.json")
    const result = await fetcher({"miniapp.example.com": rebinding})("https://miniapp.example.com/")
    expect(result).toEqual({kind: "unreachable", reason: "private_address"})
    expect(dialed).toEqual([PUBLIC_A])
    expect(requests).toHaveLength(1)
  })

  test("a redirect to a private address is refused", async () => {
    handler = (request, socket) => {
      if (request.headers.host === "miniapp.example.com") redirect(socket, "https://internal.example.com/miniapp.json")
      else respond(socket, 200, {}, MANIFEST)
    }
    const result = await fetcher({...exampleDns, "internal.example.com": ["10.0.0.5"]})("https://miniapp.example.com/")
    expect(result).toEqual({kind: "unreachable", reason: "private_address"})
    expect(dialed).toEqual([PUBLIC_A])
    for (const location of ["https://127.0.0.1/miniapp.json", "https://[::ffff:169.254.169.254]/miniapp.json"]) {
      handler = (_request, socket) => redirect(socket, location)
      expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "private_address"})
    }
  })

  test("follows three redirects, checking each, and refuses a fourth", async () => {
    handler = (request, socket) => {
      const hop = Number(/\/hop(\d)\//.exec(request.requestLine)?.[1] ?? 0)
      if (hop < 3) redirect(socket, `https://other.example.com/hop${hop + 1}/miniapp.json`, [301, 307, 308][hop])
      else respond(socket, 200, {}, MANIFEST)
    }
    const result = await fetcher(exampleDns)("https://miniapp.example.com/")
    expect(result).toEqual({
      kind: "ok",
      manifest: {finalUrl: "https://other.example.com/hop3/miniapp.json", status: 200, body: MANIFEST, etag: null},
    })
    expect(requests).toHaveLength(4)
    expect(resolved).toEqual(["miniapp.example.com", "other.example.com", "other.example.com", "other.example.com"])

    requests = []
    handler = (request, socket) => {
      const hop = Number(/\/hop(\d)\//.exec(request.requestLine)?.[1] ?? 0)
      redirect(socket, `/hop${hop + 1}/miniapp.json`, 303)
    }
    expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "too_many_redirects"})
    expect(requests).toHaveLength(MINIAPP_FETCH_MAX_REDIRECTS + 1)
  })

  test("refuses a redirect off HTTPS port 443, with credentials, or without one Location", async () => {
    for (const respondWith of [
      (socket: tls.TLSSocket) => redirect(socket, "http://miniapp.example.com/miniapp.json"),
      (socket: tls.TLSSocket) => redirect(socket, "https://miniapp.example.com:8443/miniapp.json"),
      (socket: tls.TLSSocket) => redirect(socket, "https://user:pass@miniapp.example.com/miniapp.json"),
      (socket: tls.TLSSocket) => redirect(socket, "file:///etc/passwd"),
      (socket: tls.TLSSocket) => redirect(socket, "https://[::1"),
      (socket: tls.TLSSocket) => respond(socket, 302, {}),
      (socket: tls.TLSSocket) => respond(socket, 302, {Location: "/a", location: "/b"}),
    ]) {
      requests = []
      handler = (_request, socket) => respondWith(socket)
      expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "bad_redirect"})
      expect(requests).toHaveLength(1)
    }
  })

  test("sends no cookies, even when a redirect sets one", async () => {
    handler = (request, socket) => {
      if (request.requestLine.includes("/second/")) respond(socket, 200, {}, MANIFEST)
      else respond(socket, 302, {Location: "/second/miniapp.json", "Set-Cookie": "session=abc; Path=/"})
    }
    expect((await fetcher(exampleDns)("https://miniapp.example.com/")).kind).toBe("ok")
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
    }
  })

  test("a 401 with the sign-in challenge names the package", async () => {
    handler = (_request, socket) => respond(socket, 401, {"WWW-Authenticate": 'Bearer realm="mentra", package="com.example.tools"'})
    expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "challenge", packageName: "com.example.tools"})
  })

  test("only the URL's own server may ask for sign-in: a challenge after a redirect is a refusal", async () => {
    handler = (request, socket) => {
      if (request.headers.host === "miniapp.example.com") redirect(socket, "https://other.example.com/miniapp.json")
      else respond(socket, 401, {"WWW-Authenticate": 'Bearer realm="mentra", package="com.example.tools"'})
    }
    expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "refused", status: 401})
  })

  test("a 401 without the sign-in challenge, a 403, a 404 and a 410 are refusals", async () => {
    for (const [status, headers] of [
      [401, {}],
      [401, {"WWW-Authenticate": 'Basic realm="mentra"'}],
      [401, {"WWW-Authenticate": 'Bearer realm="other", package="com.example.tools"'}],
      [401, {"WWW-Authenticate": 'Bearer realm="mentra"'}],
      [401, {"WWW-Authenticate": 'Bearer realm="mentra", package="Not A Package"'}],
      [403, {}],
      [404, {}],
      [410, {}],
    ] as const) {
      handler = (_request, socket) => respond(socket, status, headers)
      expect({status, headers, result: await fetcher(exampleDns)("https://miniapp.example.com/")}).toEqual({
        status,
        headers,
        result: {kind: "refused", status},
      })
    }
  })

  test("sends the bearer token only when asked, follows no redirect with it, and reads a 401 to it as a refusal", async () => {
    // Every b64token character, in a made-up value.
    const token = "test-token.Aa0_~+/.signature=="
    const fetch = fetcher(exampleDns)
    expect((await fetch("https://miniapp.example.com/", {bearer: token})).kind).toBe("ok")
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${token}`)

    requests = []
    handler = (_request, socket) => redirect(socket, "/elsewhere/miniapp.json")
    expect(await fetch("https://miniapp.example.com/", {bearer: token})).toEqual({kind: "unreachable", reason: "bad_redirect"})
    expect(requests).toHaveLength(1)

    handler = (_request, socket) => respond(socket, 401, {"WWW-Authenticate": 'Bearer realm="mentra", package="com.example.tools"'})
    expect(await fetch("https://miniapp.example.com/", {bearer: token})).toEqual({kind: "refused", status: 401})
  })

  test("refuses a bearer token that could break out of its header", async () => {
    const fetch = fetcher(exampleDns)
    for (const bearer of ["", "abc\r\nCookie: x=1", "a b", "tök"]) {
      await expect(fetch("https://miniapp.example.com/", {bearer})).rejects.toThrow(TypeError)
    }
    expect(requests).toEqual([])
  })

  test("reads exactly 64 KB, and refuses one byte more however the body is framed", async () => {
    const fits = "x".repeat(MINIAPP_FETCH_MAX_BYTES)
    const over = "x".repeat(MINIAPP_FETCH_MAX_BYTES + 1)
    handler = (_request, socket) => respond(socket, 200, {}, fits)
    const ok = await fetcher(exampleDns)("https://miniapp.example.com/")
    expect(ok.kind === "ok" && ok.manifest.body.length).toBe(MINIAPP_FETCH_MAX_BYTES)

    const framings: Array<(socket: tls.TLSSocket) => void> = [
      socket => respond(socket, 200, {}, over),
      socket => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 10000000\r\n\r\n`),
      socket => socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${over}`),
      socket => {
        const half = MINIAPP_FETCH_MAX_BYTES / 2
        socket.end(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${half.toString(16)}\r\n${"x".repeat(half)}\r\n${(half + 1).toString(16)}\r\n${"x".repeat(half + 1)}\r\n0\r\n\r\n`)
      },
      socket => socket.end(`HTTP/1.1 200 OK\r\nX-Big: ${"h".repeat(20_000)}\r\nContent-Length: 2\r\n\r\n{}`),
    ]
    for (const framing of framings) {
      handler = (_request, socket) => framing(socket)
      expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "too_large"})
    }
  })

  test("decodes a chunked body with extensions and trailers, and a body that runs to the close", async () => {
    handler = (_request, socket) =>
      socket.end(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\n{"a":\r\nA\r\n"bcdefghi"\r\n1\r\n}\r\n0\r\nX-Trailer: 1\r\n\r\n`)
    const chunked = await fetcher(exampleDns)("https://miniapp.example.com/")
    expect(chunked.kind === "ok" && chunked.manifest.body).toBe('{"a":"bcdefghi"}')

    handler = (_request, socket) => socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n${MANIFEST}`)
    const untilClose = await fetcher(exampleDns)("https://miniapp.example.com/")
    expect(untilClose.kind === "ok" && untilClose.manifest.body).toBe(MANIFEST)
  })

  test("skips an interim 103 response and strips a UTF-8 byte order mark", async () => {
    handler = (_request, socket) =>
      socket.end(`HTTP/1.1 103 Early Hints\r\nLink: </icon.png>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(MANIFEST) + 3}\r\n\r\n﻿${MANIFEST}`)
    const result = await fetcher(exampleDns)("https://miniapp.example.com/")
    expect(result.kind === "ok" && result.manifest.body).toBe(MANIFEST)
  })

  test("answers bad_response for a status or response it can't use", async () => {
    for (const write of [
      (socket: tls.TLSSocket) => respond(socket, 500, {}, "oops"),
      (socket: tls.TLSSocket) => respond(socket, 503, {"Retry-After": "10"}),
      (socket: tls.TLSSocket) => respond(socket, 429, {}),
      (socket: tls.TLSSocket) => respond(socket, 204, {}),
      (socket: tls.TLSSocket) => respond(socket, 304, {}),
      (socket: tls.TLSSocket) => respond(socket, 200, {"Content-Encoding": "gzip"}, "\x1f\x8b"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"),
      (socket: tls.TLSSocket) => socket.end("HTTP/2 200\r\n\r\n{}"),
      (socket: tls.TLSSocket) => socket.end("SSH-2.0-OpenSSH\r\n\r\n"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n{}"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nX-Folded: a\r\n b\r\nContent-Length: 2\r\n\r\n{}"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}XX0\r\n\r\n"),
    ]) {
      handler = (_request, socket) => write(socket)
      expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "bad_response"})
    }
  })

  test("a connection that ends before the response is complete is unreachable", async () => {
    for (const write of [
      (socket: tls.TLSSocket) => socket.end(),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nContent-Le"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}"),
      (socket: tls.TLSSocket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n"),
    ]) {
      handler = (_request, socket) => write(socket)
      expect(await fetcher(exampleDns)("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "connect"})
    }
  })

  test("gives up on a slow body within the overall time limit", async () => {
    handler = (_request, socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
      const drip = setInterval(() => (socket.destroyed ? clearInterval(drip) : socket.write("x")), 50)
      socket.on("close", () => clearInterval(drip))
    }
    const started = Date.now()
    expect(await fetcher(exampleDns, {timeoutMs: 300})("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "timeout"})
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  test("the time limit covers the whole fetch, redirects included", async () => {
    handler = (request, socket) => {
      const hop = Number(/\/hop(\d)\//.exec(request.requestLine)?.[1] ?? 0)
      setTimeout(() => redirect(socket, `/hop${hop + 1}/miniapp.json`), 150)
    }
    const started = Date.now()
    expect(await fetcher(exampleDns, {timeoutMs: 400})("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "timeout"})
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(requests.length).toBeLessThanOrEqual(3)
  })

  test("gives up on a server that never completes the TLS handshake, and on slow DNS", async () => {
    expect(await fetcher({"miniapp.example.com": [HANGING]}, {timeoutMs: 300})("https://miniapp.example.com/")).toEqual({
      kind: "unreachable",
      reason: "timeout",
    })
    const slowDns = createMiniappFetcher({resolve: () => new Promise(() => {}), timeoutMs: 200})
    expect(await slowDns("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "timeout"})
  })

  test("refuses a certificate that doesn't name the host, or that isn't trusted", async () => {
    expect(await fetcher({"wrong.example.net": [PUBLIC_A]})("https://wrong.example.net/")).toEqual({kind: "unreachable", reason: "tls"})
    expect(await fetcher(exampleDns, {ca: undefined})("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "tls"})
    // An address literal the certificate doesn't name, on a connection without SNI.
    const anyAddress = createMiniappFetcher({dial: () => ({host: "127.0.0.1", port: serverPort}), ca: certificate.cert})
    expect(await anyAddress("https://93.184.215.16/")).toEqual({kind: "unreachable", reason: "tls"})
    expect(await anyAddress(`https://${PUBLIC_A}/`)).toMatchObject({kind: "ok"})
    expect(requests).toHaveLength(1)
  })

  test("sends the URL's host as SNI to the checked address", async () => {
    let clientHello: Buffer | null = null
    const recorder = net.createServer(socket => {
      socket.once("data", chunk => {
        clientHello = Buffer.from(chunk)
        socket.destroy()
      })
    })
    const recorderPort = await listen(recorder)
    try {
      const fetch = createMiniappFetcher({
        resolve: async () => [PUBLIC_A],
        dial: () => ({host: "127.0.0.1", port: recorderPort}),
        ca: certificate.cert,
      })
      await fetch("https://miniapp.example.com/")
      expect(clientHello).not.toBeNull()
      expect(clientHello!.includes(Buffer.from("miniapp.example.com"))).toBe(true)
    } finally {
      recorder.close()
    }
  })

  test("refuses a server that doesn't speak TLS", async () => {
    const plain = net.createServer(socket => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"))
    const plainPort = await listen(plain)
    try {
      const fetch = createMiniappFetcher({
        resolve: async () => [PUBLIC_A],
        dial: () => ({host: "127.0.0.1", port: plainPort}),
        ca: certificate.cert,
      })
      expect(await fetch("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "tls"})
    } finally {
      plain.close()
    }
  })

  test("tries the host's next checked address when one refuses the connection, IPv4 first", async () => {
    const result = await fetcher({"miniapp.example.com": [PUBLIC_V6, PUBLIC_B]})("https://miniapp.example.com/")
    expect(result.kind).toBe("ok")
    expect(dialed).toEqual([PUBLIC_B, PUBLIC_V6])
    dialed = []
    expect(await fetcher({"miniapp.example.com": [PUBLIC_B]})("https://miniapp.example.com/")).toEqual({kind: "unreachable", reason: "connect"})
    expect(dialed).toEqual([PUBLIC_B])
  })

  test("the default fetcher refuses loopback literals without any network", async () => {
    expect(await fetchMiniappManifest("https://127.0.0.1/")).toEqual({kind: "unreachable", reason: "private_address"})
    expect(await fetchMiniappManifest("https://[::1]/")).toEqual({kind: "unreachable", reason: "private_address"})
    expect(await fetchMiniappManifest("http://example.com/")).toEqual({kind: "unreachable", reason: "bad_url"})
  })

  test("its limits are the spec's", () => {
    expect(MINIAPP_FETCH_MAX_BYTES).toBe(64 * 1024)
    expect(MINIAPP_FETCH_TIMEOUT_MS).toBe(5_000)
    expect(MINIAPP_FETCH_MAX_REDIRECTS).toBe(3)
  })
})

describe("mentraChallengePackage", () => {
  test("reads the package of the Mentra bearer challenge", () => {
    expect(mentraChallengePackage(['Bearer realm="mentra", package="com.acme.tools"'])).toBe("com.acme.tools")
    expect(mentraChallengePackage(['bearer Realm="mentra",Package="com.acme.tools"'])).toBe("com.acme.tools")
    expect(mentraChallengePackage(['Basic realm="files", Bearer realm="mentra", package="com.acme.tools", error="invalid_token"'])).toBe(
      "com.acme.tools",
    )
    expect(mentraChallengePackage(['Basic realm="files"', 'Bearer realm="mentra", package="com.acme.tools"'])).toBe("com.acme.tools")
    expect(mentraChallengePackage(['Bearer realm=mentra, package=com.acme.tools'])).toBe("com.acme.tools")
    // A quoted-pair stands for the character it escapes.
    expect(mentraChallengePackage(['Bearer realm="men\\tra", package="com.acme.tools"'])).toBe("com.acme.tools")
  })

  test("is null without exactly one valid Mentra package", () => {
    for (const values of [
      [],
      [""],
      ['Basic realm="mentra"'],
      ['Bearer realm="mentra"'],
      ['Bearer package="com.acme.tools"'],
      ['Bearer realm="other", package="com.acme.tools"'],
      ['Bearer realm="mentra", package="com.acme.tools", package="com.evil.tools"'],
      ['Bearer realm="mentra", package="com.acme.tools"', 'Bearer realm="mentra", package="com.evil.tools"'],
      ['Bearer realm="mentra", package="Com.Acme"'],
      ['Bearer realm="mentra", package="acme"'],
      ['Bearer realm="mentra", package="com.acme-tools.x"'],
      ['Bearer realm="mentra", package="com.acme.tools'],
      [`Bearer realm="mentra", package="com.${"a".repeat(260)}"`],
      ['Bearer realm="mentra", package="com.acme.tools\r\nX: y"'],
    ]) {
      expect({values, packageName: mentraChallengePackage(values)}).toEqual({values, packageName: null})
    }
  })
})
