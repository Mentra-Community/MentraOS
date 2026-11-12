import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {BlockList, isIPv4} from "node:net"
import test from "node:test"
import {fileURLToPath} from "node:url"
import {CLOUD_V2_TARGETS} from "../../../.github/scripts/coordinated-cloud-v2-records.mjs"

const manifest = fileURLToPath(new URL("core-egress-networkpolicy.yaml", import.meta.url))

function load() {
  const result = spawnSync(
    process.env.BUN_BIN || "bun",
    ["-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))", manifest],
    {encoding: "utf8"},
  )
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean)
}

const policies = load()
const byEnvironment = new Map(policies.map(policy => [policy.metadata?.labels?.["mentra.glass/environment"], policy]))

// Every private, internal or non-routable IPv4 range Core must never reach.
const DENIED_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
]
const DENIED_IPV6 = ["::1/128", "::ffff:0:0/96", "64:ff9b::/96", "fc00::/7", "fe80::/10", "ff00::/8"]

function cidrList(cidrs) {
  const list = new BlockList()
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split("/")
    list.addSubnet(address, Number(prefix), isIPv4(address) ? "ipv4" : "ipv6")
  }
  return list
}

function contains(cidr, address) {
  const [base] = cidr.split("/")
  if (isIPv4(base) !== isIPv4(address)) return false
  return cidrList([cidr]).check(address, isIPv4(address) ? "ipv4" : "ipv6")
}

function portMatches(ports, port, protocol) {
  if (!ports?.length) return true
  return ports.some(entry => (entry.protocol ?? "TCP") === protocol && (entry.port === undefined || entry.port === port))
}

// NetworkPolicy egress semantics for an address: allowed when any rule's ports
// match and any of its ipBlock peers holds the address outside its excepts.
// Selector peers name pods, not addresses, so they never admit a raw address.
function allows(policy, address, port, protocol = "TCP") {
  return (policy.spec.egress ?? []).some(rule => {
    if (!portMatches(rule.ports, port, protocol)) return false
    if (!rule.to) return true
    return rule.to.some(peer => peer.ipBlock && contains(peer.ipBlock.cidr, address) &&
      !(peer.ipBlock.except ?? []).some(except => contains(except, address)))
  })
}

// The addresses Core's configured upstreams resolved to from a dev Core pod:
// Atlas, Supabase and Cloudflare, Slack, PostHog, Sentry, GitHub, Better
// Stack, Entra ID, and the cluster's own public ingress for MFM and the Store.
const PUBLIC_UPSTREAMS = [
  ["89.195.210.123", 27017],
  ["172.64.149.246", 443],
  ["104.18.38.10", 443],
  ["172.67.210.229", 443],
  ["104.16.8.34", 443],
  ["54.245.50.245", 443],
  ["3.41.202.166", 443],
  ["34.160.81.0", 443],
  ["20.29.134.17", 443],
  ["195.63.225.5", 443],
  ["20.190.190.195", 443],
  ["34.208.214.65", 443],
  ["2606:4700:2ff9::1", 443],
]

test("one Core egress policy per Cloud V2 environment, selecting only that environment's Core pods", () => {
  assert.deepEqual([...byEnvironment.keys()].sort(), Object.keys(CLOUD_V2_TARGETS).sort())
  assert.equal(policies.length, Object.keys(CLOUD_V2_TARGETS).length)
  for (const [environment, target] of Object.entries(CLOUD_V2_TARGETS)) {
    const policy = byEnvironment.get(environment)
    assert.equal(policy.apiVersion, "networking.k8s.io/v1")
    assert.equal(policy.kind, "NetworkPolicy")
    assert.equal(policy.metadata.name, `${target.porterApp}-core-egress`)
    assert.equal(policy.metadata.namespace, "default")
    assert.equal(policy.metadata.labels["app.kubernetes.io/managed-by"], "kubectl")
    assert.deepEqual(policy.spec.podSelector, {
      matchLabels: {"porter.run/app-name": target.porterApp, "porter.run/service-name": "core"},
    })
    // Egress only: inbound traffic to Core stays as it is.
    assert.deepEqual(policy.spec.policyTypes, ["Egress"])
    assert.equal(policy.spec.ingress, undefined)
  }
})

test("every environment gets the same egress rules", () => {
  const [first, ...rest] = policies.map(policy => JSON.stringify(policy.spec.egress))
  for (const egress of rest) assert.equal(egress, first)
})

test("the instance metadata address and every private range are denied on every port", () => {
  for (const policy of policies) {
    for (const address of ["169.254.169.254", "169.254.170.23", "fd00:ec2::254"]) {
      for (const [port, protocol] of [[80, "TCP"], [443, "TCP"], [53, "UDP"], [53, "TCP"]]) {
        assert.equal(allows(policy, address, port, protocol), false, `${address}:${port}/${protocol}`)
      }
    }
    for (const address of [
      "10.0.0.1", "10.76.0.2", "10.77.12.34", "10.255.255.255", "172.16.0.1", "172.21.0.1", "172.31.255.255",
      "192.168.1.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "0.0.0.0", "192.0.0.8", "198.18.0.1",
      "198.19.255.255", "224.0.0.1", "255.255.255.255", "::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "fc00::1",
      "fd12:3456::1", "fe80::1", "ff02::1",
    ]) {
      for (const port of [80, 443, 3000, 3004, 6379, 8080, 27017]) {
        assert.equal(allows(policy, address, port), false, `${address}:${port}`)
      }
    }
  }
})

test("Core keeps its public upstreams, on any port", () => {
  for (const policy of policies) {
    for (const [address, port] of PUBLIC_UPSTREAMS) {
      assert.equal(allows(policy, address, port), true, `${address}:${port}`)
    }
    // The edges just outside the private ranges stay public.
    for (const address of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0",
      "192.167.255.255", "192.169.0.0", "169.253.255.255", "169.255.0.0", "198.17.255.255", "198.20.0.0"]) {
      assert.equal(allows(policy, address, 443), true, address)
    }
  }
})

test("the public allow excludes the full private list for IPv4 and IPv6", () => {
  for (const policy of policies) {
    const blocks = policy.spec.egress.flatMap(rule => (rule.to ?? []).map(peer => ({rule, block: peer.ipBlock})))
      .filter(({block}) => block)
    const v4 = blocks.find(({block}) => block.cidr === "0.0.0.0/0")
    const v6 = blocks.find(({block}) => block.cidr === "::/0")
    assert.ok(v4 && v6, "allows 0.0.0.0/0 and ::/0")
    assert.deepEqual([...v4.block.except].sort(), [...DENIED_IPV4].sort())
    assert.deepEqual([...v6.block.except].sort(), [...DENIED_IPV6].sort())
    // No rule opens everything: each rule names its peers.
    for (const rule of policy.spec.egress) assert.ok(rule.to?.length, "every egress rule names its peers")
  }
})

test("cluster DNS is the only private destination, and only on port 53", () => {
  for (const policy of policies) {
    const isPrivatePeer = peer => !peer.ipBlock || (!["0.0.0.0/0", "::/0"].includes(peer.ipBlock.cidr) &&
      [...DENIED_IPV4, ...DENIED_IPV6].some(range => contains(range, peer.ipBlock.cidr.split("/")[0])))
    const privateRules = policy.spec.egress.filter(rule => rule.to.some(isPrivatePeer))
    assert.equal(privateRules.length, 1)
    const [dns] = privateRules
    assert.deepEqual(dns.ports, [{protocol: "UDP", port: 53}, {protocol: "TCP", port: 53}])
    assert.deepEqual(dns.to, [
      {
        namespaceSelector: {matchLabels: {"kubernetes.io/metadata.name": "kube-system"}},
        podSelector: {matchLabels: {"k8s-app": "kube-dns"}},
      },
      {ipBlock: {cidr: "172.21.0.10/32"}},
      {ipBlock: {cidr: "169.254.20.10/32"}},
    ])
    for (const address of ["172.21.0.10", "169.254.20.10"]) {
      assert.equal(allows(policy, address, 53, "UDP"), true)
      assert.equal(allows(policy, address, 53, "TCP"), true)
      assert.equal(allows(policy, address, 443), false)
      assert.equal(allows(policy, address, 80), false)
    }
  }
})
