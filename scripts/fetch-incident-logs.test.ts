import {afterEach, expect, test} from "bun:test"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {spawn} from "node:child_process"
import {fileURLToPath} from "node:url"

const token = "test-private-report-token-".repeat(3)
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, {recursive: true, force: true})
})

async function run(args: string[], env: Record<string, string>) {
  const child = spawn("bash", [fileURLToPath(new URL("./fetch-incident-logs.sh", import.meta.url)), ...args], {
    env: {PATH: process.env.PATH, ...env},
    stdio: ["ignore", "pipe", "pipe"],
  })
  return await new Promise<{code: number | null; stdout: string; stderr: string}>((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (data) => {
      stdout += data
    })
    child.stderr.on("data", (data) => {
      stderr += data
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({code, stdout, stderr}))
  })
}

test("private report credentials require an explicit Core and cannot enumerate reports", async () => {
  const missingCore = await run(["--agent", "rep_test", "--json"], {MENTRA_REPORT_AGENT_TOKEN: token})
  expect(missingCore.code).toBe(1)
  expect(missingCore.stderr).toContain("requires MENTRA_CORE_URL")
  const listing = await run(["--agent", "--list"], {
    MENTRA_REPORT_AGENT_TOKEN: token,
    MENTRA_CORE_URL: "https://example.invalid",
  })
  expect(listing.code).toBe(1)
  expect(listing.stderr).toContain("listing is not supported")
})

test.each([false, true])("downloads report and logs through the selected API (agent=%s)", async (agent) => {
  const dir = await mkdtemp(join(tmpdir(), "mentra-reports-"))
  tempDirs.push(dir)
  const prefix = agent ? "/api/agent/reports" : "/api/admin/reports"
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === `${prefix}/rep_test`)
        return Response.json({
          report: {
            kind: "bug",
            status: "ready",
            artifacts: [{artifactId: "art_logs", type: "logs", source: "phone", contentType: "application/json"}],
          },
        })
      if (path === `${prefix}/rep_test/artifacts/art_logs`) return Response.json({entries: [{message: "test log"}]})
      return new Response("not found", {status: 404})
    },
  })
  try {
    const result = await run([...(agent ? ["--agent"] : []), "rep_test", "--out", dir], {
      MENTRA_CORE_URL: server.url.origin,
      [agent ? "MENTRA_REPORT_AGENT_TOKEN" : "MENTRA_ADMIN_TOKEN"]: token,
    })
    expect(result.code).toBe(0)
    expect(requests).toEqual([`${prefix}/rep_test`, `${prefix}/rep_test/artifacts/art_logs`])
    expect(JSON.parse(await readFile(join(dir, "01-logs-phone.json"), "utf8"))).toEqual({
      entries: [{message: "test log"}],
    })
    expect(result.stdout + result.stderr).not.toContain(token)
  } finally {
    server.stop(true)
  }
})
