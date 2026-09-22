import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {loadReleaseFamily} from "./release-family.mjs"
import {
  isHttpsRegistryUrl,
  isNpmConflictError,
  npmMembersInOrder,
  npmReleaseTag,
  npmReadbackAttempts,
  npmStagedVersionConflict,
  npmReadbackWaitSeconds,
  npmViewPublishedTarball,
  NPM_READBACK_POLL_SECONDS,
  publishWithRetry,
  releaseMetadataArgs,
  requireNpmProvenanceSource,
  requirePlanSourceCommit,
  resolveNpmReleaseTag,
  sha512Integrity,
} from "./publish-release-npm.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("maps coordinated channels to npm tags", () => {
  assert.equal(npmReleaseTag("dev"), "dev")
  assert.equal(npmReleaseTag("beta"), "beta")
  assert.throws(() => npmReleaseTag("production"), /explicit candidate dist-tag/)
  assert.throws(() => npmReleaseTag("nightly"), /Unsupported/)
  assert.equal(resolveNpmReleaseTag("production", "candidate-3-1-0"), "candidate-3-1-0")
  assert.throws(() => resolveNpmReleaseTag("production", "3.1.0"), /Invalid npm dist-tag/)
})

test("selects npm packages in dependency order", () => {
  const family = loadReleaseFamily()
  const names = npmMembersInOrder(family, [
    "@mentra/miniapp",
    "@mentra/crust",
    "@mentra/cloud-client",
    "@mentra/cloud-protocol",
    "@mentra/jspolyfill",
  ])
  assert.deepEqual(names, [
    "@mentra/jspolyfill",
    "@mentra/cloud-protocol",
    "@mentra/crust",
    "@mentra/cloud-client",
    "@mentra/miniapp",
  ])
})

test("selects the complete npm family in dependency order", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  const selected = npmMembersInOrder(family, ["all"])
  assert.equal(selected.length, family.members.filter((member) => member.publishTargets.includes("npm")).length)
  assert.equal(selected.includes("@mentra/types"), false)
  assert.ok(selected.includes("@mentra/glasses-media"))
  assert.ok(selected.indexOf("@mentra/glasses-media") < selected.indexOf("@mentra/acs-meeting"))
  assert.equal(selected.at(-1), "@mentra/engine")
})

test("all npm release members have public publication and valid provenance metadata", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  for (const member of family.members.filter((member) => member.publishTargets.includes("npm"))) {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, member.manifest), "utf8"))
    assert.notEqual(manifest.private, true, member.name)
    assert.equal(manifest.publishConfig?.access, "public", member.name)
    requireNpmProvenanceSource(manifest, member.manifest)
  }
})

test("admits Engine only as the final selected npm package", () => {
  const family = loadReleaseFamily()
  const names = npmMembersInOrder(family, ["@mentra/engine", "@mentra/bluetooth-sdk"])
  assert.deepEqual(names, ["@mentra/bluetooth-sdk", "@mentra/engine"])
})

test("creates npm-compatible SHA-512 integrity values", () => {
  assert.match(sha512Integrity(Buffer.from("mentra")), /^sha512-[A-Za-z0-9+/]+=*$/)
})

test("accepts only propagated HTTPS npm tarball metadata", () => {
  assert.equal(isHttpsRegistryUrl("https://registry.npmjs.org/@mentra/crust/-/crust-3.1.0.tgz"), true)
  assert.equal(isHttpsRegistryUrl(""), false)
  assert.equal(isHttpsRegistryUrl(null), false)
  assert.equal(isHttpsRegistryUrl("http://registry.npmjs.org/package.tgz"), false)
})

test("waits through empty npm metadata until the registry exposes the tarball", () => {
  const responses = ["", null, '"https://registry.npmjs.org/package/-/package-3.1.0.tgz"']
  let sleeps = 0
  assert.equal(
    npmViewPublishedTarball("package@3.1.0", {
      attempts: responses.length,
      view: () => responses.shift(),
      sleep: () => {
        sleeps += 1
      },
    }),
    "https://registry.npmjs.org/package/-/package-3.1.0.tgz",
  )
  assert.equal(sleeps, 2)
})

test("waits at least 30 minutes for npm to finish processing a publish", () => {
  assert.equal(npmReadbackWaitSeconds(), 30 * 60)
  assert.equal(npmReadbackWaitSeconds(1024), 30 * 60)
  assert.equal(npmReadbackAttempts(), (30 * 60) / NPM_READBACK_POLL_SECONDS + 1)

  let sleeps = 0
  const progress = []
  assert.equal(
    npmViewPublishedTarball("package@3.1.0", {
      view: () => "",
      sleep: () => {
        sleeps += 1
      },
      log: (line) => progress.push(line),
    }),
    null,
  )
  assert.equal(sleeps * NPM_READBACK_POLL_SECONDS, 30 * 60)
  assert.equal(progress.length, 6)
  assert.match(progress[0], /^npm has not exposed package@3\.1\.0 yet; waited 300s of up to 1800s$/)
  assert.match(progress.at(-1), /waited 1800s of up to 1800s$/)
})

test("waits longer for larger tarballs before giving up on the read-back", () => {
  const bluetoothSdkBytes = Math.round(18.5 * 1024 * 1024)
  assert.equal(npmReadbackWaitSeconds(bluetoothSdkBytes), 19 * 2 * 60)
  assert.ok(npmReadbackWaitSeconds(bluetoothSdkBytes) > npmReadbackWaitSeconds())
  assert.ok(npmReadbackWaitSeconds(60 * 1024 * 1024) > npmReadbackWaitSeconds(bluetoothSdkBytes))

  let sleeps = 0
  let views = 0
  assert.equal(
    npmViewPublishedTarball("@mentra/bluetooth-sdk@3.1.0-beta.192", {
      tarballBytes: bluetoothSdkBytes,
      view: () => {
        views += 1
        return null
      },
      sleep: () => {
        sleeps += 1
      },
      log: () => {},
    }),
    null,
  )
  assert.equal(views, sleeps + 1)
  assert.equal(sleeps * NPM_READBACK_POLL_SECONDS, npmReadbackWaitSeconds(bluetoothSdkBytes))
  assert.ok(sleeps * NPM_READBACK_POLL_SECONDS > 30 * 60)
})

test("requires the package checkout to match the immutable release plan", () => {
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: repositoryRoot, encoding: "utf8"}).trim()
  assert.equal(requirePlanSourceCommit(repositoryRoot, sourceCommit), sourceCommit)
  assert.throws(() => requirePlanSourceCommit(repositoryRoot, "a".repeat(40)), /expected a{40}/)
})

test("requires every npm member to identify its exact MentraOS source directory", () => {
  const family = loadReleaseFamily({rootDir: repositoryRoot})
  for (const member of family.members.filter((candidate) => candidate.publishTargets.includes("npm"))) {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, member.manifest), "utf8"))
    assert.doesNotThrow(() => requireNpmProvenanceSource(packageJson, member.manifest))
  }
  assert.throws(
    () =>
      requireNpmProvenanceSource(
        {name: "@mentra/crust", repository: "https://github.com/fossephate/crust"},
        "mobile/modules/crust/package.json",
      ),
    /does not identify mobile\/modules\/crust in MentraOS/,
  )
})

test("stamps SDK and Engine packages from the same immutable release metadata", () => {
  assert.deepEqual(
    releaseMetadataArgs({
      plan: {
        familyBaseVersion: "3.1.0",
        releaseIdentity: "3.1.0-beta.57",
        releaseSetId: "mentra-3.1.0-beta.57",
        sourceCommit: "a".repeat(40),
      },
      otaManifestUrl: "https://example.com/ota.json",
      otaManifestSha256: "b".repeat(64),
    }),
    [
      "--family-base-version",
      "3.1.0",
      "--release-identity",
      "3.1.0-beta.57",
      "--release-set-id",
      "mentra-3.1.0-beta.57",
      "--source-commit",
      "a".repeat(40),
      "--ota-manifest-url",
      "https://example.com/ota.json",
      "--ota-manifest-sha256",
      "b".repeat(64),
    ],
  )
})

test("retries a publish that fails before Sigstore issues a certificate", () => {
  let calls = 0
  const status = publishWithRetry("@mentra/engine@3.2.0-dev.157", "sha512-abc", {
    publish: () => {
      calls += 1
      if (calls < 3) throw new Error("CA_CREATE_SIGNING_CERTIFICATE_ERROR: read ECONNRESET")
    },
    registryIntegrityOf: () => null,
    sleep: () => {},
  })
  assert.equal(status, "published")
  assert.equal(calls, 3)
})

test("accepts a publish that landed even though the command reported failure", () => {
  let calls = 0
  const status = publishWithRetry("@mentra/engine@3.2.0-dev.157", "sha512-abc", {
    publish: () => {
      calls += 1
      throw new Error("write ECONNRESET")
    },
    registryIntegrityOf: () => "sha512-abc",
    sleep: () => {},
  })
  assert.equal(status, "published")
  assert.equal(calls, 1)
})

test("refuses a registry copy whose bytes differ from the packed tarball", () => {
  assert.throws(
    () =>
      publishWithRetry("@mentra/engine@3.2.0-dev.157", "sha512-abc", {
        publish: () => {
          throw new Error("boom")
        },
        registryIntegrityOf: () => "sha512-different",
        sleep: () => {},
      }),
    /already exists on npm with different bytes/,
  )
})

test("gives up after the last attempt and surfaces the publish error", () => {
  let calls = 0
  assert.throws(
    () =>
      publishWithRetry("@mentra/engine@3.2.0-dev.157", "sha512-abc", {
        attempts: 3,
        publish: () => {
          calls += 1
          throw new Error("read ECONNRESET")
        },
        registryIntegrityOf: () => null,
        sleep: () => {},
      }),
    /read ECONNRESET/,
  )
  assert.equal(calls, 3)
})

test("retries when the recovery registry read also fails", () => {
  let publishes = 0
  let reads = 0
  let pauses = 0
  const status = publishWithRetry("@mentra/engine@3.2.0-dev.157", "sha512-abc", {
    publish: () => {
      publishes += 1
      throw new Error("publish connection reset")
    },
    registryIntegrityOf: () => {
      reads += 1
      if (reads === 1) throw new Error("registry unavailable")
      return "sha512-abc"
    },
    sleep: () => {
      pauses += 1
    },
  })
  assert.equal(status, "published")
  assert.equal(publishes, 2)
  assert.equal(reads, 2)
  assert.equal(pauses, 1)
})

test("keeps bounded attempts and the publish error when every recovery read fails", () => {
  let publishes = 0
  let pauses = 0
  const publishError = new Error("publish connection reset")
  assert.throws(
    () =>
      publishWithRetry("@mentra/engine@3.2.0-dev.157", "sha512-abc", {
        attempts: 3,
        publish: () => {
          publishes += 1
          throw publishError
        },
        registryIntegrityOf: () => {
          throw new Error("registry unavailable")
        },
        sleep: () => {
          pauses += 1
        },
      }),
    (error) => error === publishError,
  )
  assert.equal(publishes, 3)
  assert.equal(pauses, 2)
})

// The stderr npm printed in run 34833322934 (2026-09-14) when the re-run of a
// publish npm was still processing reached the registry.
function stagedVersionConflictText(name, version) {
  return [
    `npm error code E409`,
    `npm error 409 Conflict - PUT https://registry.npmjs.org/${encodeURIComponent(name)} - Cannot publish over previously staged version "${version}".`,
    `npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-09-14T10_30_26_355Z-debug-0.log`,
    "",
  ].join("\n")
}

function failedNpmPublish(name, version, stderr) {
  return new Error(
    `npm publish release-output/${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz --tag candidate-${version} --access public --provenance failed with exit code 1\n${stderr}`,
  )
}

test("recognises npm's staged-version publish conflict", () => {
  const text = stagedVersionConflictText("@mentra/bluetooth-sdk", "3.1.1")
  assert.equal(isNpmConflictError(text), true)
  assert.equal(npmStagedVersionConflict(text), "3.1.1")
  assert.equal(
    npmStagedVersionConflict("npm error code E409\nnpm error 409 Conflict - cannot modify pre-existing version: 3.1.1"),
    null,
  )
  assert.equal(isNpmConflictError("CA_CREATE_SIGNING_CERTIFICATE_ERROR: read ECONNRESET"), false)
  assert.equal(npmStagedVersionConflict('Cannot publish over previously staged version "3.1.1"'), null)
})

test("treats a conflict with its own staged version as published and awaits the read-back", () => {
  const name = "@mentra/bluetooth-sdk"
  const version = "3.1.1"
  let publishes = 0
  let sleeps = 0
  const log = []
  const status = publishWithRetry(`${name}@${version}`, "sha512-abc", {
    publish: () => {
      publishes += 1
      throw failedNpmPublish(name, version, stagedVersionConflictText(name, version))
    },
    registryIntegrityOf: () => null,
    sleep: () => {
      sleeps += 1
    },
    log: (line) => log.push(line),
  })
  assert.equal(status, "published")
  assert.equal(publishes, 1)
  assert.equal(sleeps, 0)
  assert.match(log.at(-1), /already holds @mentra\/bluetooth-sdk@3\.1\.1 as a staged publish/)
})

test("fails closed on a staged-version conflict for a different version", () => {
  let publishes = 0
  assert.throws(
    () =>
      publishWithRetry("@mentra/bluetooth-sdk@3.1.1", "sha512-abc", {
        publish: () => {
          publishes += 1
          throw failedNpmPublish(
            "@mentra/bluetooth-sdk",
            "3.1.1",
            stagedVersionConflictText("@mentra/bluetooth-sdk", "3.1.0"),
          )
        },
        registryIntegrityOf: () => null,
        sleep: () => assert.fail("a conflict must not be retried"),
        log: () => {},
      }),
    /conflict that is not its own staged version[\s\S]*previously staged version "3\.1\.0"/,
  )
  assert.equal(publishes, 1)
})

test("fails closed without retrying on any other npm conflict", () => {
  let publishes = 0
  assert.throws(
    () =>
      publishWithRetry("@mentra/engine@3.1.1", "sha512-abc", {
        publish: () => {
          publishes += 1
          throw failedNpmPublish(
            "@mentra/engine",
            "3.1.1",
            "npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@mentra%2fengine - cannot modify pre-existing version: 3.1.1\n",
          )
        },
        registryIntegrityOf: () => null,
        sleep: () => assert.fail("a conflict must not be retried"),
        log: () => {},
      }),
    /conflict that is not its own staged version[\s\S]*cannot modify pre-existing version/,
  )
  assert.equal(publishes, 1)
})
