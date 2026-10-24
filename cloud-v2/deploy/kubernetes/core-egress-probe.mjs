// Checks Core's egress from inside a Core pod: every upstream in Core's own
// configuration must connect, and private addresses must be dropped. Prints
// only setting names, hosts, ports and results, never a setting's value.
// Exits 1 on any failure.
//
//   kubectl exec -i -n default deploy/cloud-dev-core -c cloud-dev-core -- \
//     sh -c 'cat > /tmp/core-egress-probe.mjs && bun /tmp/core-egress-probe.mjs 10.76.0.2:53' \
//     < deploy/kubernetes/core-egress-probe.mjs
//
// Arguments are extra private host:port targets that must be dropped (the
// VPC's resolver, another node). See docs/runbooks/core-egress-policy.md.
import dns from "node:dns/promises"
import net from "node:net"

const TIMEOUT_MS = 4000

// Settings Core can't run without; a pod missing one fails the probe.
export const REQUIRED_SETTINGS = [["MONGO_URL"], ["SUPABASE_URL"],
  ["CLOUD_STORAGE_S3_ENDPOINT", "CLOUD_CORE_STORAGE_S3_ENDPOINT", "CLOUD_CORE_R2_ENDPOINT", "R2_ENDPOINT"]]
// Settings that name an upstream in some environments only.
export const OPTIONAL_SETTINGS = [
  "CLOUD_CORE_FLEET_URL",
  "CLOUD_CORE_BILLING_URL",
  "POSTHOG_HOST",
  "SENTRY_DSN",
  "CLOUD_REPORT_AGENT_URL",
  "CLOUD_REPORTS_SLACK_WEBHOOK_URL",
]
// Upstreams fixed in Core's code.
export const FIXED_UPSTREAMS = [
  ["github", "api.github.com", 443],
  ["resend", "api.resend.com", 443],
  ["npm", "registry.npmjs.org", 443],
]

export function connect(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({host, port})
    const timer = setTimeout(() => {
      socket.destroy()
      resolve("timeout")
    }, TIMEOUT_MS)
    socket.once("connect", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve("open")
    })
    socket.once("error", error => {
      clearTimeout(timer)
      resolve(error.code || "error")
    })
  })
}

function urlTarget(value) {
  try {
    const url = new URL(value)
    if (!url.hostname) return null
    return [url.hostname, Number(url.port) || (url.protocol === "http:" ? 80 : 443)]
  } catch {
    return null
  }
}

// Mongo's hosts: a mongodb+srv:// URL names an SRV record, a mongodb:// URL
// lists host:port pairs.
async function mongoTargets(value, resolveSrv) {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(value)
  if (!match) throw new Error("not a mongodb URL")
  if (!match[1]) {
    return match[2].split(",").map(pair => {
      const [host, port] = pair.split(":")
      return [host, Number(port) || 27017]
    })
  }
  const records = await resolveSrv(`_mongodb._tcp.${match[2]}`)
  if (!records.length) throw new Error("no SRV records")
  return records.map(record => [record.name, record.port])
}

function hostPort(argument) {
  const at = argument.lastIndexOf(":")
  const port = Number(argument.slice(at + 1))
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return [argument.slice(0, at), port]
}

/**
 * Runs the probe. `connect` and `resolveSrv` are injectable for tests.
 * Returns the report lines and whether any check failed.
 */
export async function probe({env, extraDenied = [], connect: open = connect, resolveSrv = dns.resolveSrv}) {
  const lines = []
  let failed = false
  const fail = line => {
    failed = true
    lines.push(`FAIL ${line}`)
  }

  const allowed = []
  for (const names of REQUIRED_SETTINGS) {
    const name = names.find(candidate => env[candidate])
    if (!name) {
      fail(`missing ${names.join(" or ")}: run the probe inside a Core pod`)
      continue
    }
    if (name === "MONGO_URL") {
      try {
        for (const [host, port] of await mongoTargets(env[name], resolveSrv)) allowed.push([name, host, port])
      } catch (error) {
        fail(`allowed ${name} lookup failed (${error.code || error.message})`)
      }
      continue
    }
    const target = urlTarget(env[name])
    if (target) allowed.push([name, ...target])
    else fail(`allowed ${name} is not a URL`)
  }
  for (const name of OPTIONAL_SETTINGS) {
    const target = env[name] && urlTarget(env[name])
    if (target) allowed.push([name, ...target])
    else lines.push(`skip allowed ${name} (not set)`)
  }
  allowed.push(...FIXED_UPSTREAMS)

  const denied = [
    ["instance metadata", "169.254.169.254", 80],
    ["VPC resolver (link-local)", "169.254.169.253", 53],
  ]
  if (env.KUBERNETES_SERVICE_HOST) {
    denied.push(["Kubernetes API", env.KUBERNETES_SERVICE_HOST, Number(env.KUBERNETES_SERVICE_PORT) || 443])
  } else {
    fail("missing KUBERNETES_SERVICE_HOST: run the probe inside a Core pod")
  }
  for (const argument of extraDenied) {
    const target = hostPort(argument)
    if (target) denied.push(["private target", ...target])
    else fail(`bad target ${argument}: expected host:port`)
  }

  for (const [name, host, port] of allowed) {
    const result = await open(host, port)
    if (result === "open") lines.push(`ok   allowed ${name} ${host}:${port} open`)
    else fail(`allowed ${name} ${host}:${port} ${result}`)
  }
  for (const [name, host, port] of denied) {
    const result = await open(host, port)
    // The policy drops the packet, so the connection times out. Anything
    // else means a reply came back: open, or refused, is not enforced.
    if (result === "timeout") lines.push(`ok   denied  ${name} ${host}:${port} timeout`)
    else fail(`denied  ${name} ${host}:${port} ${result}${result === "open" ? "" : " (a reply came back: not dropped)"}`)
  }
  return {lines, failed}
}

if (import.meta.main) {
  const {lines, failed} = await probe({env: process.env, extraDenied: process.argv.slice(2)})
  for (const line of lines) console.log(line)
  process.exit(failed ? 1 : 0)
}
