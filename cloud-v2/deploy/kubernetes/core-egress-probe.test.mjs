import assert from "node:assert/strict"
import test from "node:test"
import {probe} from "./core-egress-probe.mjs"

const POD_ENV = {
  MONGO_URL: "mongodb+srv://user:secret-password@cluster.example.net/core",
  SUPABASE_URL: "https://auth.example.com",
  CLOUD_STORAGE_S3_ENDPOINT: "https://storage.example.com",
  CLOUD_CORE_FLEET_URL: "https://fleet.example.com/base",
  KUBERNETES_SERVICE_HOST: "172.21.0.1",
  KUBERNETES_SERVICE_PORT: "443",
}
const PRIVATE = new Set(["169.254.169.254", "169.254.169.253", "172.21.0.1", "10.76.0.2"])
const resolveSrv = async () => [{name: "shard-0.example.net", port: 27017}, {name: "shard-1.example.net", port: 27017}]
// The network as the policy leaves it: public hosts connect, private ones drop.
const enforced = async host => (PRIVATE.has(host) ? "timeout" : "open")

test("passes when every upstream connects and every private target is dropped", async () => {
  const {lines, failed} = await probe({env: POD_ENV, extraDenied: ["10.76.0.2:53"], connect: enforced, resolveSrv})
  assert.equal(failed, false, lines.join("\n"))
  assert.ok(lines.includes("ok   allowed MONGO_URL shard-0.example.net:27017 open"))
  assert.ok(lines.includes("ok   allowed CLOUD_CORE_FLEET_URL fleet.example.com:443 open"))
  assert.ok(lines.includes("ok   denied  instance metadata 169.254.169.254:80 timeout"))
  assert.ok(lines.includes("ok   denied  Kubernetes API 172.21.0.1:443 timeout"))
  assert.ok(lines.includes("ok   denied  private target 10.76.0.2:53 timeout"))
  assert.ok(lines.includes("skip allowed CLOUD_CORE_BILLING_URL (not set)"))
  // Never a setting's value.
  assert.equal(lines.some(line => line.includes("secret-password") || line.includes("/core")), false)
})

test("fails before the policy, when private targets answer", async () => {
  const {lines, failed} = await probe({env: POD_ENV, connect: async () => "open", resolveSrv})
  assert.equal(failed, true)
  assert.ok(lines.includes("FAIL denied  instance metadata 169.254.169.254:80 open"))
})

test("a refused connection is a reply, not a drop", async () => {
  const connect = async (host, port) => (host === "172.21.0.1" ? "ECONNREFUSED" : enforced(host, port))
  const {lines, failed} = await probe({env: POD_ENV, connect, resolveSrv})
  assert.equal(failed, true)
  assert.ok(lines.includes("FAIL denied  Kubernetes API 172.21.0.1:443 ECONNREFUSED (a reply came back: not dropped)"))
})

test("an upstream that times out or doesn't resolve fails", async () => {
  const connect = async (host, port) => (host === "auth.example.com" ? "timeout" : enforced(host, port))
  let result = await probe({env: POD_ENV, connect, resolveSrv})
  assert.equal(result.failed, true)
  assert.ok(result.lines.includes("FAIL allowed SUPABASE_URL auth.example.com:443 timeout"))

  const brokenDns = async () => {
    throw Object.assign(new Error("lookup failed"), {code: "ECONNREFUSED"})
  }
  result = await probe({env: POD_ENV, connect: enforced, resolveSrv: brokenDns})
  assert.equal(result.failed, true)
  assert.ok(result.lines.includes("FAIL allowed MONGO_URL lookup failed (ECONNREFUSED)"))
})

test("outside a Core pod, missing settings fail instead of being skipped", async () => {
  const {lines, failed} = await probe({env: {}, connect: enforced, resolveSrv})
  assert.equal(failed, true)
  assert.ok(lines.includes("FAIL missing MONGO_URL: run the probe inside a Core pod"))
  assert.ok(lines.includes("FAIL missing SUPABASE_URL: run the probe inside a Core pod"))
  assert.ok(lines.includes("FAIL missing KUBERNETES_SERVICE_HOST: run the probe inside a Core pod"))
  assert.ok(lines.some(line => line.startsWith("FAIL missing CLOUD_STORAGE_S3_ENDPOINT or")))
})

test("a malformed extra target fails", async () => {
  const {lines, failed} = await probe({env: POD_ENV, extraDenied: ["10.76.0.2"], connect: enforced, resolveSrv})
  assert.equal(failed, true)
  assert.ok(lines.includes("FAIL bad target 10.76.0.2: expected host:port"))
})
