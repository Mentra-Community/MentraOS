import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {createHash} from "node:crypto"
import {once} from "node:events"
import {mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {createServer, request} from "node:http"
import {request as httpsRequest} from "node:https"
import {createServer as tcpServer} from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  findReleaseAsset,
  matchingAsset,
  publishReleaseAsset,
  releaseAssetUploadUrl,
  uploadReleaseAsset,
  verifyReleaseAsset,
} from "./publish-immutable-release-asset.mjs"

test("selects one immutable release asset and rejects duplicates", () => {
  assert.equal(matchingAsset([{name: "one"}, {name: "two"}], "two").name, "two")
  assert.equal(matchingAsset([{name: "one"}], "missing"), null)
  assert.throws(() => matchingAsset([{name: "one"}, {name: "one"}], "one"), /duplicate/)
})

test("targets GitHub's release upload host without enterprise API routing", () => {
  assert.equal(
    releaseAssetUploadUrl("Mentra-Community/MentraOS", "123", "Mentra 3.1.0 #1.apk"),
    "https://uploads.github.com/repos/Mentra-Community/MentraOS/releases/123/assets?name=Mentra%203.1.0%20%231.apk",
  )
})

const coordinates = {repository: "owner/repo", releaseId: "123", name: "asg.apk", token: "test-token", log: () => {}}

function fixture(t, body = Buffer.from("mentra-live-asg")) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mentra-upload-test-"))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = path.join(dir, coordinates.name)
  writeFileSync(file, body)
  return {file, body}
}

async function transport(t, handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return (url, options, callback) => {
    assert.equal(url, releaseAssetUploadUrl(coordinates.repository, coordinates.releaseId, coordinates.name))
    return request(`http://127.0.0.1:${server.address().port}/asset`, options, callback)
  }
}

function publisher(overrides = {}) {
  return {
    ...coordinates,
    file: "/unused/asg.apk",
    findAsset: () => null,
    wait: async () => {},
    verify: async () => assert.fail("unexpected verification"),
    removeAsset: async () => assert.fail("unexpected deletion"),
    ...overrides,
  }
}

function failure(properties) {
  return Object.assign(new Error("upload failed"), properties)
}

const uploaded = {id: 1, name: "asg.apk", state: "uploaded", size: 15}
const starter = {...uploaded, state: "starter", size: 0}

test("streams a multi-megabyte file with exact length, intact bytes and no chunked encoding", async (t) => {
  const {file, body} = fixture(t, Buffer.alloc(8 * 1024 * 1024, 0xab))
  let received = 0,
    chunks = 0
  const requestImpl = await transport(t, (req, res) => {
    assert.equal(req.method, "POST")
    assert.equal(req.headers["content-length"], String(body.length))
    assert.equal(req.headers["transfer-encoding"], undefined)
    assert.equal(req.headers.authorization, "Bearer test-token")
    assert.equal(req.headers["content-type"], "application/octet-stream")
    const hash = createHash("sha256")
    req.on("data", (chunk) => {
      received += chunk.length
      chunks++
      hash.update(chunk)
    })
    req.on("end", () => {
      assert.equal(hash.digest("hex"), createHash("sha256").update(body).digest("hex"))
      res.writeHead(201).end("{}")
    })
  })
  await uploadReleaseAsset({...coordinates, file, requestImpl})
  assert.equal(received, body.length)
  assert.ok(chunks > 1)
})

test("surfaces a bounded HTML rejection and does not retry permanent HTTP 400", async (t) => {
  const {file} = fixture(t)
  let calls = 0
  const requestImpl = await transport(t, (req, res) => {
    calls++
    req.resume()
    res.writeHead(400).end("<html>\n  <h1>Whoa there!</h1>\n</html>" + "x".repeat(2000))
  })
  await assert.rejects(
    publishReleaseAsset(publisher({file, upload: (args) => uploadReleaseAsset({...args, requestImpl})})),
    (error) => {
      assert.match(error.message, /HTTP 400: <html> <h1>Whoa there!<\/h1> <\/html>/)
      assert.ok(error.message.length < 400)
      return true
    },
  )
  assert.equal(calls, 1)
})

test("bounds a TLS connection that never completes its handshake", async (t) => {
  const {file} = fixture(t)
  const sockets = new Set()
  const server = tcpServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  const requestImpl = (url, options, callback) =>
    httpsRequest(`https://127.0.0.1:${server.address().port}`, options, callback)
  await assert.rejects(
    uploadReleaseAsset({...coordinates, file, requestImpl, connectTimeoutMs: 40}),
    (error) => error.code === "ETIMEDOUT" && /connection/.test(error.message),
  )
})

test("bounds a request that receives no response headers", async (t) => {
  const {file} = fixture(t)
  const requestImpl = await transport(t, (req) => req.resume())
  await assert.rejects(
    uploadReleaseAsset({...coordinates, file, requestImpl, idleTimeoutMs: 40}),
    (error) => error.code === "ETIMEDOUT" && /no network activity/.test(error.message),
  )
})

test("bounds a response that keeps trickling bytes past the total deadline", async (t) => {
  const {file} = fixture(t)
  const requestImpl = await transport(t, (req, res) => {
    req.resume()
    res.writeHead(201)
    const timer = setInterval(() => res.write(" "), 10)
    res.on("close", () => clearInterval(timer))
  })
  await assert.rejects(
    uploadReleaseAsset({...coordinates, file, requestImpl, idleTimeoutMs: 1000, totalTimeoutMs: 80}),
    (error) => error.code === "ETIMEDOUT" && /total transfer deadline/.test(error.message),
  )
})

test("reopens the file and sends every byte after a dropped connection", async (t) => {
  const {file, body} = fixture(t, Buffer.alloc(2 * 1024 * 1024, 0xcd))
  let attempts = 0,
    received = 0
  const requestImpl = await transport(t, (req, res) => {
    attempts++
    if (attempts === 1) {
      req.once("data", () => req.socket.destroy())
      return
    }
    req.on("data", (chunk) => {
      received += chunk.length
    })
    req.on("end", () => res.writeHead(201).end("{}"))
  })
  const delays = []
  await publishReleaseAsset(
    publisher({
      file,
      wait: async (ms) => delays.push(ms),
      upload: (args) => uploadReleaseAsset({...args, requestImpl}),
    }),
  )
  assert.equal(attempts, 2)
  assert.equal(received, body.length)
  assert.deepEqual(delays, [5000])
})

test("honors Retry-After from GitHub before retrying a rate-limited upload", async (t) => {
  const {file} = fixture(t)
  let attempts = 0
  const requestImpl = await transport(t, (req, res) => {
    req.resume()
    if (++attempts === 1) res.writeHead(429, {"retry-after": "12"}).end("slow down")
    else res.writeHead(201).end("{}")
  })
  const delays = []
  await publishReleaseAsset(
    publisher({
      file,
      wait: async (ms) => delays.push(ms),
      upload: (args) => uploadReleaseAsset({...args, requestImpl}),
    }),
  )
  assert.deepEqual(delays, [12000])
  assert.equal(attempts, 2)
})

test("refuses to upload without a token", async () => {
  await assert.rejects(uploadReleaseAsset({repository: "o/r", releaseId: "1", name: "a.apk"}), /GH_TOKEN is required/)
})

for (const error of [failure({code: "ETIMEDOUT"}), failure({status: 422})]) {
  test(`verifies a committed asset after ${error.code || error.status}, even on the last attempt`, async () => {
    let lookups = 0,
      verifications = 0,
      uploads = 0
    await publishReleaseAsset(
      publisher({
        maxAttempts: 1,
        findAsset: () => (++lookups === 1 ? null : uploaded),
        upload: async () => {
          uploads++
          throw error
        },
        verify: async ({asset}) => {
          assert.equal(asset, uploaded)
          verifications++
        },
      }),
    )
    assert.equal(uploads, 1)
    assert.equal(verifications, 1)
  })
}

test("refuses different bytes after an ambiguous upload without overwriting or retrying", async () => {
  let lookups = 0,
    uploads = 0
  await assert.rejects(
    publishReleaseAsset(
      publisher({
        findAsset: () => (++lookups === 1 ? null : uploaded),
        upload: async () => {
          uploads++
          throw failure({code: "ECONNRESET"})
        },
        verify: async () => {
          throw new Error("different bytes")
        },
      }),
    ),
    /different bytes/,
  )
  assert.equal(uploads, 1)
})

test("cleans only an empty starter after this invocation receives terminal HTTP 502", async () => {
  let existing = null,
    uploads = 0
  const removed = []
  await publishReleaseAsset(
    publisher({
      findAsset: () => existing,
      upload: async () => {
        if (++uploads === 1) {
          existing = starter
          throw failure({status: 502})
        }
      },
      removeAsset: async (id) => {
        removed.push(id)
        existing = null
      },
    }),
  )
  assert.equal(uploads, 2)
  assert.deepEqual(removed, [starter.id])
})

test("rechecks a starter before cleanup and preserves an asset that finished meanwhile", async () => {
  let lookups = 0,
    verifications = 0
  await publishReleaseAsset(
    publisher({
      maxAttempts: 1,
      findAsset: () => [null, starter, uploaded][lookups++],
      upload: async () => {
        throw failure({status: 502})
      },
      verify: async () => {
        verifications++
      },
    }),
  )
  assert.equal(verifications, 1)
})

for (const error of [failure({code: "ETIMEDOUT"}), failure({status: 502})]) {
  test(`preserves an ambiguous or nonempty partial asset after ${error.code || error.status}`, async () => {
    let existing = null,
      uploads = 0
    await assert.rejects(
      publishReleaseAsset(
        publisher({
          findAsset: () => existing,
          upload: async () => {
            uploads++
            existing = {...starter, size: error.status === 502 ? 123 : 0}
            throw error
          },
        }),
      ),
      /incomplete/,
    )
    assert.equal(uploads, 1)
  })
}

test("does not delete or overwrite a starter left by an earlier invocation", async () => {
  await assert.rejects(
    publishReleaseAsset(
      publisher({findAsset: () => starter, upload: async () => assert.fail("must not upload over a starter")}),
    ),
    /incomplete/,
  )
})

test("waits for an ambiguous upload to finish instead of sending it again", async () => {
  let lookups = 0,
    verifications = 0
  await publishReleaseAsset(
    publisher({
      findAsset: () => [null, starter, uploaded][lookups++],
      upload: async () => {
        throw failure({code: "ETIMEDOUT"})
      },
      verify: async () => {
        verifications++
      },
    }),
  )
  assert.equal(verifications, 1)
})

test("stops after three attempts with exponential backoff", async () => {
  let uploads = 0
  const delays = []
  await assert.rejects(
    publishReleaseAsset(
      publisher({
        wait: async (ms) => delays.push(ms),
        upload: async () => {
          uploads++
          throw failure({status: 503})
        },
      }),
    ),
    /after 3 attempts/,
  )
  assert.equal(uploads, 3)
  assert.deepEqual(delays, [5000, 10000])
})

for (const status of [400, 401, 403, 404, 422]) {
  test(`does not retry permanent HTTP ${status} when no asset was committed`, async () => {
    let uploads = 0
    await assert.rejects(
      publishReleaseAsset(
        publisher({
          upload: async () => {
            uploads++
            throw failure({status})
          },
        }),
      ),
      /upload failed/,
    )
    assert.equal(uploads, 1)
  })
}

test("fails instead of retrying before a long Retry-After elapses", async () => {
  await assert.rejects(
    publishReleaseAsset(
      publisher({
        wait: async () => assert.fail("must not wait indefinitely"),
        upload: async () => {
          throw failure({status: 429, retryAfterMs: 300000})
        },
      }),
    ),
    /upload failed/,
  )
})

test("streams byte verification and rejects equal-sized but different content", async (t) => {
  const {file, body} = fixture(t)
  for (const same of [true, false]) {
    const promise = verifyReleaseAsset({
      repository: coordinates.repository,
      file,
      asset: {...uploaded, size: body.length},
      spawnImpl: () =>
        spawn(process.execPath, [
          "-e",
          "process.stdout.write(process.argv[1])",
          same ? body.toString() : "x".repeat(body.length),
        ]),
    })
    if (same) await promise
    else await assert.rejects(promise, /different bytes/)
  }
})

test("rejects an incomplete verification download even if it returned matching bytes", async (t) => {
  const {file, body} = fixture(t)
  await assert.rejects(
    verifyReleaseAsset({
      repository: coordinates.repository,
      file,
      asset: {...uploaded, size: body.length},
      spawnImpl: () =>
        spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.exitCode = 1", body.toString()]),
    }),
    /verification failed/,
  )
})

test("filters all release asset pages inside gh and safely quotes the exact name", () => {
  const name = 'Mentra "quoted" \\ build.apk'
  const asset = {id: 123, name}
  const result = findReleaseAsset("owner/repo", "456", name, (args, options) => {
    assert.deepEqual(args, [
      "api",
      "--paginate",
      "repos/owner/repo/releases/456/assets?per_page=100",
      "--jq",
      `.[] | select(.name == ${JSON.stringify(name)}) | {id, name, state, size} | tojson`,
    ])
    assert.equal(options.encoding, "utf8")
    return JSON.stringify(asset)
  })
  assert.deepEqual(result, asset)
})

test("filtered lookups retain missing-asset and duplicate-asset behavior", () => {
  assert.equal(
    findReleaseAsset("owner/repo", "1", "missing", () => ""),
    null,
  )
  assert.throws(
    () => findReleaseAsset("owner/repo", "1", "one", () => '{"id":1,"name":"one"}\n{"id":2,"name":"one"}\n'),
    /duplicate asset one/,
  )
  assert.throws(() => findReleaseAsset("owner/repo", "1", "one", () => "invalid JSON"), SyntaxError)
})
