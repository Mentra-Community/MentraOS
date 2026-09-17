import assert from "node:assert/strict"
import {once} from "node:events"
import {mkdtempSync, rmSync, writeFileSync} from "node:fs"
import {createServer} from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  findReleaseAsset,
  matchingAsset,
  publishImmutableReleaseAsset,
  releaseAssetUploadUrl,
  runCurl,
  uploadReleaseAsset,
} from "./publish-immutable-release-asset.mjs"

function sourceFile(context) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mentra-upload-"))
  context.after(() => rmSync(directory, {recursive: true, force: true}))
  const file = path.join(directory, "asg.apk")
  const body = Buffer.from([0, 1, 2, 10, 13, 128, 255])
  writeFileSync(file, body)
  return {file, body}
}

async function uploadServer(context, handler) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  context.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return `http://127.0.0.1:${server.address().port}/assets?name=asg.apk`
}

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

test("streams exact file bytes with a fixed length and a deadline beyond Node's headers timeout", async (context) => {
  const {file, body} = sourceFile(context)
  const requests = []
  const url = await uploadServer(context, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({method: request.method, headers: request.headers, body: Buffer.concat(chunks)})
    response.writeHead(201).end('{"state":"uploaded"}')
  })
  await uploadReleaseAsset({
    repository: "Mentra-Community/MentraOS",
    releaseId: "123",
    name: "asg.apk",
    file,
    token: "release-token",
    run: (args, token) => {
      assert.equal(args.at(-1), releaseAssetUploadUrl("Mentra-Community/MentraOS", "123", "asg.apk"))
      assert.ok(Number(args[args.indexOf("--max-time") + 1]) > 300)
      assert.ok(!args.some((arg) => arg.includes(token)), "token must not appear in process arguments")
      return runCurl([...args.slice(0, -1), url], token)
    },
  })

  assert.equal(requests.length, 1)
  const [request] = requests
  assert.equal(request.method, "POST")
  assert.equal(request.headers["content-length"], String(body.byteLength))
  assert.equal(request.headers["transfer-encoding"], undefined)
  assert.equal(request.headers["content-type"], "application/octet-stream")
  assert.equal(request.headers.authorization, "Bearer release-token")
  assert.deepEqual(request.body, body)
})

test("surfaces the upload host's HTML rejection instead of a bare exit code", async (context) => {
  const {file} = sourceFile(context)
  const url = await uploadServer(context, (request, response) => {
    request.resume()
    response.writeHead(400).end("<html>\n  <h1>Whoa there!</h1>\n</html>")
  })
  await assert.rejects(
    uploadReleaseAsset({
      repository: "Mentra-Community/MentraOS",
      releaseId: "123",
      name: "asg.apk",
      file,
      token: "release-token",
      run: (args, token) => runCurl([...args.slice(0, -1), url], token),
    }),
    {message: "Uploading asg.apk failed with HTTP 400: <html> <h1>Whoa there!</h1> </html>", retryable: false},
  )
})

test("a stalled upload has a bounded, retryable failure without exposing its token", async (context) => {
  const {file} = sourceFile(context)
  const url = await uploadServer(context, (request) => request.resume())
  await assert.rejects(
    uploadReleaseAsset({
      repository: "o/r",
      releaseId: "1",
      name: "asg.apk",
      file,
      token: "secret-token",
      run: (args, token) => {
        const localArgs = [...args.slice(0, -1), url]
        localArgs[localArgs.indexOf("--max-time") + 1] = "0.1"
        return runCurl(localArgs, token)
      },
    }),
    (error) => {
      assert.match(error.message, /curl exited with code 28/)
      assert.equal(error.retryable, true)
      assert.ok(!error.message.includes("secret-token"))
      return true
    },
  )
})

test("retries transient HTTP failures and reconciles conflicts, but fails fast on authorization errors", async (context) => {
  const {file} = sourceFile(context)
  for (const status of [401, 403, 408, 422, 429, 500, 502, 503]) {
    await assert.rejects(
      uploadReleaseAsset({
        repository: "o/r",
        releaseId: "1",
        name: "asg.apk",
        file,
        token: "token",
        run: async () => `error\n${status}`,
      }),
      {retryable: ![401, 403].includes(status)},
    )
  }
})

test("refuses to upload without a token", async () => {
  await assert.rejects(
    uploadReleaseAsset({repository: "o/r", releaseId: "1", name: "a.apk", file: "unused"}),
    /GH_TOKEN is required/,
  )
})

test("filters all release asset pages inside gh and safely quotes the exact name", () => {
  const name = 'Mentra "quoted" \\ build.apk'
  const asset = {id: 123, name, state: "uploaded", size: 12}
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

function publication(context) {
  const {file, body} = sourceFile(context)
  const state = {asset: null, bytes: body, uploads: 0, deletes: 0, waits: 0}
  const uploaded = {id: 123, name: "asg.apk", state: "uploaded", size: body.length}
  const options = {
    file,
    name: "asg.apk",
    releaseId: "1",
    repository: "owner/repo",
    token: "token",
    run: (args) => {
      if (args.includes("--paginate")) return state.asset ? JSON.stringify(state.asset) : ""
      if (args.includes("DELETE")) {
        assert.equal(state.asset.state, "starter", "must never delete a completed asset")
        assert.equal(state.asset.size, 0)
        state.deletes += 1
        state.asset = null
        return ""
      }
      assert.ok(args.includes("Accept: application/octet-stream"))
      return state.bytes
    },
    upload: async () => {
      state.uploads += 1
    },
    sleepImpl: async () => {
      state.waits += 1
    },
  }
  return {options, state, uploaded}
}

function transientFailure() {
  return Object.assign(new Error("upload timed out"), {retryable: true})
}

test("retries a timed-out upload after checking remote state", async (context) => {
  const {options, state} = publication(context)
  options.upload = async () => {
    if (++state.uploads === 1) throw transientFailure()
  }
  await publishImmutableReleaseAsset(options)
  assert.equal(state.uploads, 2)
  assert.equal(state.waits, 1)
  assert.equal(state.deletes, 0)
})

test("verifies an accepted upload after a lost response instead of posting it again", async (context) => {
  const {options, state, uploaded} = publication(context)
  options.upload = async () => {
    state.uploads += 1
    state.asset = uploaded
    throw transientFailure()
  }
  await publishImmutableReleaseAsset(options)
  assert.equal(state.uploads, 1)
  assert.equal(state.deletes, 0)
})

test("reconciles a lost response even on the final upload attempt", async (context) => {
  const {options, state, uploaded} = publication(context)
  options.upload = async () => {
    if (++state.uploads === 3) state.asset = uploaded
    throw transientFailure()
  }
  await publishImmutableReleaseAsset(options)
  assert.equal(state.uploads, 3)
  assert.equal(state.deletes, 0)
})

test("rejects different completed bytes discovered during retry", async (context) => {
  const {options, state, uploaded} = publication(context)
  options.upload = async () => {
    state.uploads += 1
    state.asset = uploaded
    state.bytes = Buffer.from("different bytes")
    throw transientFailure()
  }
  await assert.rejects(publishImmutableReleaseAsset(options), /Refusing to overwrite immutable release asset/)
  assert.equal(state.uploads, 1)
  assert.equal(state.deletes, 0)
})

test("reuses matching completed assets without uploading", async (context) => {
  const {options, state, uploaded} = publication(context)
  state.asset = uploaded
  await publishImmutableReleaseAsset(options)
  assert.equal(state.uploads, 0)
  assert.equal(state.deletes, 0)
})

test("removes an empty starter left by an interrupted upload before retrying", async (context) => {
  const {options, state, uploaded} = publication(context)
  options.upload = async () => {
    if (++state.uploads === 1) {
      state.asset = {...uploaded, state: "starter", size: 0}
      throw transientFailure()
    }
  }
  await publishImmutableReleaseAsset(options)
  assert.equal(state.uploads, 2)
  assert.equal(state.deletes, 1)
})

test("recovers an empty starter on a rerun but rejects nonempty or unknown states", async (context) => {
  for (const assetState of ["starter", "unexpected"]) {
    for (const size of [0, 1]) {
      const {options, state, uploaded} = publication(context)
      state.asset = {...uploaded, state: assetState, size}
      if (assetState === "starter" && size === 0) {
        await publishImmutableReleaseAsset(options)
        assert.equal(state.uploads, 1)
        assert.equal(state.deletes, 1)
      } else {
        await assert.rejects(publishImmutableReleaseAsset(options), /Unexpected state/)
        assert.equal(state.uploads, 0)
        assert.equal(state.deletes, 0)
      }
    }
  }
})

test("bounds repeated transient failures to three uploads", async (context) => {
  const {options, state} = publication(context)
  options.upload = async () => {
    state.uploads += 1
    throw transientFailure()
  }
  await assert.rejects(publishImmutableReleaseAsset(options), /upload timed out/)
  assert.equal(state.uploads, 3)
  assert.equal(state.waits, 3)
})

test("does not retry permanent upload failures", async (context) => {
  const {options, state} = publication(context)
  options.upload = async () => {
    state.uploads += 1
    throw Object.assign(new Error("HTTP 403"), {retryable: false})
  }
  await assert.rejects(publishImmutableReleaseAsset(options), /HTTP 403/)
  assert.equal(state.uploads, 1)
  assert.equal(state.waits, 0)
})
