import assert from "node:assert/strict"
import {spawnSync} from "node:child_process"
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

const certificate = "e8f49381d6324f0703d464328a46eaba1f40422be3b39085d521e38885677387"
// Output verified against the published ASG 303000164 APK with SDK 36.0.0.
const certs = `Signer #1 certificate DN: CN=Mentra, OU=Mentra, O=Mentra, L=San Francisco, ST=California, C=US
Signer #1 certificate SHA-256 digest: ${certificate}
Signer #1 certificate SHA-1 digest: 7d598d5b80a60edf33a6b3adc289360985353047
Signer #1 certificate MD5 digest: 33412739cd5ec2b0477b07f48e52f5a0
`
const badging = "package: name='com.mentra.asg_client' versionCode='303000164' versionName='3.3.0'\n"
const workflow = readFileSync(new URL("../workflows/reusable-coordinated-ota.yml", import.meta.url), "utf8")
const step = workflow.split("      - name: Verify ASG signature and embedded version\n")[1].split("\n      - name:")[0]
const script = step.split("        run: |\n")[1].replace(/^          /gm, "")

function verify({certificateOutput = certs, versionOutput = badging, verifyExit = 0} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-asg-verifier-"))
  try {
    const sdk = path.join(root, "Android SDK")
    const tools = path.join(sdk, "build-tools/36.0.0")
    mkdirSync(tools, {recursive: true})
    mkdirSync(path.join(sdk, "build-tools/99.0.0"), {recursive: true})
    mkdirSync(path.join(root, "coordinated-ota-work"))
    writeFileSync(path.join(root, "certs.txt"), certificateOutput)
    writeFileSync(path.join(root, "badging.txt"), versionOutput)
    for (const [name, body] of [
      ["apksigner", `test "$*" = 'verify --print-certs coordinated-ota-work/asg.apk'\ncat certs.txt\nexit ${verifyExit}\n`],
      ["aapt", "test \"$*\" = 'dump badging coordinated-ota-work/asg.apk'\ncat badging.txt\n"],
    ]) {
      writeFileSync(path.join(tools, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}`)
      chmodSync(path.join(tools, name), 0o755)
      const newer = path.join(sdk, "build-tools/99.0.0", name)
      writeFileSync(newer, "#!/usr/bin/env bash\necho 'Unexpected unprovisioned tool' >&2\nexit 99\n")
      chmodSync(newer, 0o755)
    }
    const output = path.join(root, "output")
    const result = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: {...process.env, ANDROID_HOME: sdk, ASG_SIGNING_CERT_SHA256: certificate,
        EXPECTED_VERSION_CODE: "303000164", EXPECTED_VERSION_NAME: "3.3.0", GITHUB_OUTPUT: output},
      encoding: "utf8",
    })
    return {...result, output: result.status === 0 ? readFileSync(output, "utf8") : undefined}
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
}

test("reused ASG verification uses the provisioned SDK and exact public certificate", () => {
  assert.match(workflow, /packages: platform-tools build-tools;36\.0\.0/)
  const result = verify()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, `signing_certificate_sha256=${certificate}\n`)
  assert.match(result.stdout, /build-tools\/36\.0\.0\/apksigner/)
  assert.ok(result.stdout.includes(certs))
})

test("rejects another valid APK signing certificate", () => {
  const result = verify({certificateOutput: certs.replace(certificate, "a".repeat(64))})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /is not the production certificate/)
})

test("rejects missing certificate output without bypassing APK verification", () => {
  const result = verify({certificateOutput: ""})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /certificate <missing>/)
})

test("rejects unsuccessful APK verification even if it emits the expected certificate", () => {
  assert.equal(verify({verifyExit: 2}).status, 2)
})

test("rejects a substituted embedded ASG version code", () => {
  assert.equal(verify({versionOutput: badging.replace("303000164", "303000165")}).status, 1)
})

test("rejects a substituted embedded ASG version name", () => {
  assert.equal(verify({versionOutput: badging.replace("3.3.0", "3.3.1")}).status, 1)
})
