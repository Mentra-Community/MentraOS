/** Concrete local transport beneath the existing lifecycle lease. No reconnect,
 * recorder, pairing, fixture registration or retry policy is introduced here. */
import {createHash, randomUUID} from "node:crypto"
import {constants} from "node:fs"
import {mkdir, open, readFile} from "node:fs/promises"
import {dirname, isAbsolute, join, normalize} from "node:path"
import {isDeepStrictEqual as same} from "node:util"
import {collectReturnObservation, type ReturnEvidenceRecorder} from "./return-collector"
import {OtaCommandError, readOtaHardware, type OtaFixture} from "./ota-hardware"
import {normalizeFirmware, OtaHardwareUnavailable} from "./ota-state"
import type {FirmwareProfile} from "./firmware-profile"
import type {LifecycleContext, MutationIntent} from "./lifecycle"
import type {
  MtkFullRestoreInputs,
  MtkFullRestoreRuntime,
  MtkRestoreIdentity,
  MtkRestoreObservation,
  MtkStageEvidence,
} from "./mtk-full-restore"

type Ref = {path: string; sha256: string}
export type MtkRestoreRuntimeConfig = {
  leasePath: string
  adb: Ref
  pythonSha256: string
  bridge: Ref
  january: {directory: string; definition: Record<string, string>}
  /** Authenticated frozen profiles for permitted modern sources. Target is also allowed. */
  sourceProfiles: FirmwareProfile[]
  /** Required for writes, never for an already-target idle observation. */
  artifactVerification?: Ref
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const sha = /^[a-f\d]{64}$/
const IDLE = "UPDATE_STATUS_IDLE"
function requireProof(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message)
}
function absolute(path: string) {
  requireProof(
    isAbsolute(path) && normalize(path) === path && !/[\0\r\n]/.test(path),
    "Absolute normalized path required",
  )
  return path
}
async function writeOnce(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(typeof value === "string" ? value : JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  const parent = await open(dirname(path), "r")
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
  return {path, sha256: digest(await readFile(path))}
}
async function json(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = await file.stat()
    requireProof(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === process.getuid?.() &&
        (s.mode & 0o777) === 0o600 &&
        s.size <= 1024 * 1024,
      "Private bounded evidence required",
    )
    return JSON.parse((await file.readFile()).toString())
  } finally {
    await file.close()
  }
}
async function verify(ref: Ref, size?: number) {
  requireProof(sha.test(ref.sha256), "SHA-256 pin required")
  const file = await open(absolute(ref.path), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat(),
      hash = createHash("sha256")
    requireProof(before.isFile() && (size === undefined || before.size === size), "Pinned file size mismatch")
    for await (const bytes of file.createReadStream({autoClose: false})) hash.update(bytes)
    const after = await file.stat()
    requireProof(
      before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        hash.digest("hex") === ref.sha256,
      "Pinned file changed",
    )
  } finally {
    await file.close()
  }
}

export function createMtkFullRestoreRuntime(
  selected: MtkFullRestoreInputs,
  options: MtkRestoreRuntimeConfig,
): MtkFullRestoreRuntime {
  const input = structuredClone(selected),
    cfg = structuredClone(options)
  const profiles = [input.profile, ...cfg.sourceProfiles]
  const fixture: OtaFixture = {...input.fixture, serial: input.fixture.serials[0]}
  const latest = new Map<string, MtkRestoreObservation>()
  for (const path of [cfg.leasePath, cfg.adb.path, cfg.bridge.path, cfg.january.directory]) absolute(path)
  requireProof(
    profiles.every((p) => sha.test(p.manifest.sha256) && p.asg.versionCode > 37),
    "Only frozen modern source profiles are supported",
  )
  async function lease() {
    const value = await json(cfg.leasePath)
    requireProof(
      value.pid === process.pid && typeof value.token === "string" && value.token.length > 0,
      "Current process must own the fixture lease",
    )
  }
  async function directory(path: string) {
    await mkdir(path, {mode: 0o700})
    return path
  }
  async function command(c: LifecycleContext, argv: string[], folder?: string, gate?: (message: any) => Promise<void>) {
    await lease()
    await verify(cfg.adb)
    const actual = argv[0] === "adb" ? [cfg.adb.path, ...argv.slice(1)] : argv
    requireProof(actual[0] === cfg.adb.path || actual[0] === input.python, "Unexpected executable")
    folder ??= join(c.runDirectory, `mtk-command-${randomUUID()}`)
    await directory(folder)
    const startedAt = new Date().toISOString()
    await writeOnce(join(folder, "started.json"), {argv: actual, startedAt, automaticRetry: false})
    const stdout = await open(join(folder, "stdout.txt"), "wx", 0o600),
      stderr = await open(join(folder, "stderr.txt"), "wx", 0o600)
    let code: number | null = null,
      failure: unknown
    try {
      const child = Bun.spawn(actual, {
        stdin: gate ? "pipe" : "ignore",
        stdout: gate ? "pipe" : stdout.fd,
        stderr: stderr.fd,
        env: {
          ...process.env,
          PATH: dirname(cfg.adb.path) + ":" + process.env.PATH,
          PYTHONPYCACHEPREFIX: join(folder, "pycache"),
          PYTHONDONTWRITEBYTECODE: "1",
        },
      })
      if (gate) {
        let pending = "",
          total = 0
        try {
          for await (const bytes of child.stdout as ReadableStream<Uint8Array>) {
            total += bytes.length
            requireProof(total <= 1024 * 1024, "Bridge output exceeded bound")
            await stdout.write(bytes)
            pending += Buffer.from(bytes).toString()
            while (pending.includes("\n")) {
              const end = pending.indexOf("\n"),
                message = JSON.parse(pending.slice(0, end))
              pending = pending.slice(end + 1)
              if (message.type === "before-apply") {
                await gate(message)
                requireProof(child.stdin && typeof child.stdin !== "number", "Bridge input missing")
                child.stdin.write(JSON.stringify({owner: message.owner, approved: true}) + "\n")
                await child.stdin.flush()
              } else requireProof(message.type === "finished", "Unknown bridge message")
            }
          }
          requireProof(!pending.trim(), "Truncated bridge response")
        } catch (error) {
          failure = error
          if (child.stdin && typeof child.stdin !== "number") child.stdin.end()
        }
      }
      code = await child.exited
    } catch (error) {
      failure ??= error
    } finally {
      await stdout.sync()
      await stderr.sync()
      await stdout.close()
      await stderr.close()
      await writeOnce(join(folder, "command.json"), {
        argv: actual,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        failure: failure instanceof Error ? failure.message : null,
        automaticRetry: false,
      })
    }
    if (failure) throw failure
    const result = await json(join(folder, "command.json"))
    const output = await readFile(join(folder, "stdout.txt"))
    requireProof(output.length <= 16 * 1024 * 1024, "Command output exceeded bound")
    return {...result, argv, stdout: output.toString(), evidence: join(folder, "command.json"), folder}
  }
  async function recorder(c: LifecycleContext): Promise<ReturnEvidenceRecorder> {
    const output = await directory(join(c.runDirectory, `mtk-observation-${randomUUID()}`))
    const capture = async (argv: string[]) => {
      const result = await command(c, argv)
      if (result.exitCode !== 0) throw new OtaCommandError(`Read failed; inspect ${result.evidence}`)
      return result
    }
    return {
      output,
      capture,
      run: async (argv) => {
        const r = await capture(argv)
        return r.stdout.trim()
      },
      file: async (name, value) => {
        const path = join(output, name)
        const f = await open(path, "wx", 0o600)
        try {
          await f.writeFile(value)
          await f.sync()
        } finally {
          await f.close()
        }
        return path
      },
      json: async (name, value) => (await writeOnce(join(output, name), value)).path,
      append: async (value) => {
        await writeOnce(join(output, `event-${randomUUID()}.json`), value)
      },
    }
  }
  const proofOf = (v: MtkRestoreObservation) => (v.actual as any).writerIdentity
  const transferPath = (c: LifecycleContext, owner: string) => join(c.runDirectory, `mtk-full-${owner}.transfer.json`)
  async function bound(r: {
    context: LifecycleContext
    intent: Readonly<MutationIntent>
    source: MtkRestoreIdentity
    sourceIntent: Ref
    remote: string
  }) {
    await lease()
    await verify(r.sourceIntent)
    const original = await json(r.sourceIntent.path),
      stage = r.context.operations.find((op) => op.stepID === "restore-mtk-stage")
    requireProof(
      stage &&
        original.operationID === stage.operationID &&
        original.startedAt === stage.startedAt &&
        original.kind === "mtk-full-source/v1" &&
        original.runDirectory === r.context.runDirectory &&
        original.inputDigest === digest(Buffer.from(JSON.stringify(input))) &&
        same(original.source, r.source) &&
        original.remote === r.remote &&
        r.remote === `/storage/emulated/0/asg/mentra-restore-${stage.operationID}.zip` &&
        r.sourceIntent.path === join(r.context.runDirectory, `mtk-full-${stage.operationID}.intent.json`) &&
        same(original.target, {
          manifest: input.profile.manifest.sha256,
          version: input.profile.mtk.version,
          sha256: input.artifact.sha256,
          size: input.artifact.size,
        }),
      "Foreign runtime source/target/claim",
    )
  }
  async function closeSource(c: LifecycleContext, owner: string) {
    const original = await json(transferPath(c, owner)),
      current = latest.get(c.runDirectory)
    requireProof(
      current &&
        same(current.identity, original.source) &&
        same(proofOf(current), original.writerIdentity) &&
        current.writersIdle &&
        current.powerReady,
      "Restore source writer ownership changed",
    )
    return current
  }
  async function bridge(
    c: LifecycleContext,
    request: Record<string, unknown>,
    root: string,
    gate?: (message: any) => Promise<void>,
  ) {
    await verify({path: input.python, sha256: cfg.pythonSha256})
    await verify(cfg.bridge)
    for (const [name, sha256] of Object.entries(cfg.january.definition)) {
      requireProof(/^[a-z_]+\.py$/.test(name), "Invalid source pin")
      await verify({path: join(cfg.january.directory, name), sha256})
    }
    await directory(root)
    const ref = await writeOnce(join(root, "request.json"), {
      ...request,
      parentPid: process.pid,
      leasePath: cfg.leasePath,
      adb: cfg.adb,
      python: {path: input.python, sha256: cfg.pythonSha256},
      january: cfg.january,
      fixture,
      auditDirectory: join(root, "audit"),
    })
    return command(
      c,
      [input.python, "-B", cfg.bridge.path, "--request", ref.path, "--sha256", ref.sha256],
      join(root, "process"),
      gate,
    )
  }
  const runtime: MtkFullRestoreRuntime = {
    async read(c) {
      const rec = await recorder(c),
        run = (argv: string[]) => rec.run(argv)
      const first = await readOtaHardware(
        fixture,
        profiles.map((p) => p.mtk.version),
        profiles.map((p) => p.asg.versionCode),
        false,
        run,
      )
      const matches = profiles.filter(
        (p) =>
          normalizeFirmware(p.mtk.version) === normalizeFirmware(first.firmware) &&
          p.asg.versionCode === first.asgVersion,
      )
      requireProof(
        matches.length > 0 && matches.every((p) => same(p.asg, matches[0].asg) && same(p.bes, matches[0].bes)),
        "Ambiguous or unsupported modern source",
      )
      const profile = matches[0]
      let powerReady = false,
        power: any = null
      if (normalizeFirmware(first.firmware) !== normalizeFirmware(input.profile.mtk.version)) {
        const root = join(c.runDirectory, `mtk-power-${randomUUID()}`),
          started = Date.now() / 1000
        const response = await bridge(c, {mode: "power"}, root)
        requireProof(response.exitCode === 0, `BES power read failed; inspect ${response.evidence}`)
        power = await json(join(root, "audit/result.json"))
        requireProof(
          power.status === "passed" &&
            power.mac === fixture.bluetooth &&
            power.firmwareWrites === 0 &&
            power.mtkReady === true &&
            power.queryCount === 1 &&
            started <= power.sentAt &&
            power.sentAt <= power.observedAt &&
            power.observedAt <= power.identityRecheckedAt &&
            power.identityRecheckedAt <= Date.now() / 1000 &&
            Number.isInteger(power.voltageMillivolts) &&
            power.voltageMillivolts >= 2500 &&
            power.voltageMillivolts <= 5000,
          "Fresh BES power required",
        )
      }
      // Close the potentially slow BLE read with fresh ASG admission/engine evidence.
      const result = await collectReturnObservation({
        fixture,
        profile,
        recorder: rec,
        probe: {path: input.probe.remote, sha256: input.probe.sha256, size: 2143},
      })
      const observed = await json(join(rec.output, "observation.json")),
        idle = await json(join(rec.output, "runtime-idle-input.json"))
      const last = await readOtaHardware(fixture, [profile.mtk.version], [profile.asg.versionCode], false, run)
      const bootSerial = await run(["adb", "-t", last.transport, "shell", "getprop", "ro.boot.serialno"])
      requireProof(
        first.transport === last.transport &&
          first.bootId === last.bootId &&
          first.slot === last.slot &&
          input.fixture.serials.includes(bootSerial),
        "Identity changed during read",
      )
      requireProof(
        result.firmwareAssertions
          .filter((a) => !["app.connected", "update.idle"].includes(a.id))
          .every((a) => a.status === "passed"),
        "Modern source components or active APK not verified",
      )
      const status = /^CURRENT_OP=(\S+)$/m.exec(idle.updateEngine.value)?.[1]
      requireProof(
        status &&
          idle.updateEngine.value.split(/\r?\n/).filter((s: string) => s.startsWith("CURRENT_OP=")).length === 1,
        "Ambiguous engine status",
      )
      let writersIdle =
        result.streamStopped &&
        result.idleChecks.filter((a) => a.id !== "idle.android-update-engine").every((a) => a.passed)
      const writerIdentity = {
        process: idle.after.process.pid,
        startTicks: idle.after.process.startTicks,
        sid: idle.currentProcessSid,
        generation: idle.activity.value.admission_generation,
      }
      const identity = {
        cid: last.cid,
        serial: last.serial,
        bootSerial,
        bluetooth: last.bluetooth,
        firmware: last.firmware,
        bootId: last.bootId,
        slot: last.slot,
        bootCompleted: last.bootCompleted === "1",
        transport: last.transport,
        ...(fixture.usb ? {usb: fixture.usb} : {wifiEndpoint: fixture.wifiEndpoint!}),
      }
      for (const op of c.operations.filter((op) => op.stepID === "restore-mtk-stage")) {
        try {
          const start = await json(transferPath(c, op.operationID))
          if (start.source.bootId === identity.bootId) writersIdle &&= same(start.writerIdentity, writerIdentity)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      // Identified USB is an external supply, never an inferred PMU charging flag.
      if (power)
        powerReady =
          Date.now() / 1000 - power.observedAt <= 30 &&
          Number.isInteger(power.batteryPercent) &&
          power.batteryPercent >= 50 &&
          power.batteryPercent <= 100 &&
          (power.charging === true || !!fixture.usb)
      const observation: MtkRestoreObservation = {
        identity,
        engineStatus: status,
        writersIdle,
        powerReady,
        observedAt: new Date().toISOString(),
        source: "Modern ASG activity, independent Update Engine, exact active APK and source profile",
        expected: "Exact source, stopped media and no competing updater",
        actual: {writerIdentity, sourceProfile: profile.manifest, power, observation: observed},
        evidence: [join(rec.output, "result.json"), join(rec.output, "observation.json")],
      }
      latest.set(c.runDirectory, observation)
      await rec.json("restore-observation.json", observation)
      return observation
    },
    async verifyArtifact(_input, c) {
      await lease()
      requireProof(cfg.artifactVerification, "Selected full OTA requires its pinned offline verification record")
      await verify(input.artifact, input.artifact.size)
      await verify(input.helper)
      await verify(input.probe, 2143)
      await verify(cfg.artifactVerification)
      const report = await json(cfg.artifactVerification.path)
      requireProof(
        report.schemaVersion === 1 &&
          report.otaSha256 === input.artifact.sha256 &&
          report.otaBytes === input.artifact.size &&
          report.manifestSha256 === input.profile.manifest.sha256 &&
          report.targetVersion === input.profile.mtk.version &&
          report.fullPayload === true &&
          report.powerwash === false &&
          report.payloadSignatureVerification === "passed" &&
          report.targetPartitionVerification === "passed",
        "Selected OTA verification does not prove full non-wiping target",
      )
      const path = join(c.runDirectory, `mtk-artifact-${randomUUID()}.json`)
      await writeOnce(path, {input: input.artifact, verification: cfg.artifactVerification})
      return {
        observedAt: new Date().toISOString(),
        source: "Pinned offline full-payload and signature/partition verification",
        expected: "Selected full non-wiping OTA",
        actual: report,
        evidence: [path, cfg.artifactVerification.path],
        passed: true,
      }
    },
    async transfer(r) {
      await bound(r)
      requireProof(r.local === input.artifact.path, "Transfer must use the selected local artifact")
      await verify(input.artifact, input.artifact.size)
      await r.beforeWrite()
      const current = latest.get(r.context.runDirectory)
      requireProof(current && same(current.identity, r.source), "Missing current source gate")
      await writeOnce(transferPath(r.context, r.intent.operationID), {
        sourceIntent: r.sourceIntent,
        source: r.source,
        remote: r.remote,
        writerIdentity: proofOf(current),
      })
      const absent = await command(r.context, [
        "adb",
        "-t",
        r.source.transport,
        "shell",
        `test ! -e '${r.remote}' && test ! -L '${r.remote}'`,
      ])
      requireProof(absent.exitCode === 0, "Owned remote already exists; never resend")
      const capacity = await command(r.context, ["adb", "-t", r.source.transport, "shell", "df -k /data"])
      const fields = capacity.stdout.trim().split(/\r?\n/).at(-1)?.split(/\s+/)
      requireProof(
        capacity.exitCode === 0 && fields && Number(fields[3]) * 1024 >= input.artifact.size + 512 * 1024 * 1024,
        "Insufficient target storage",
      )
      await r.beforeWrite()
      await closeSource(r.context, r.intent.operationID)
      const closingAbsence = await command(r.context, [
        "adb",
        "-t",
        r.source.transport,
        "shell",
        `test ! -e '${r.remote}' && test ! -L '${r.remote}'`,
      ])
      requireProof(closingAbsence.exitCode === 0, "Remote appeared before transfer; never overwrite")
      const pushed = await command(r.context, ["adb", "-t", r.source.transport, "push", r.local, r.remote])
      requireProof(pushed.exitCode === 0, "Transfer ambiguous; never resend")
      const hashed = await command(r.context, [
        "adb",
        "-t",
        r.source.transport,
        "shell",
        `stat -c %s '${r.remote}' && sha256sum '${r.remote}'`,
      ])
      requireProof(
        hashed.exitCode === 0 &&
          hashed.stdout.trim().split(/\s+/)[0] === String(input.artifact.size) &&
          hashed.stdout.trim().split(/\s+/)[1] === input.artifact.sha256,
        "Remote transfer mismatch",
      )
      return {exitCode: 0, evidence: [pushed.evidence, hashed.evidence, transferPath(r.context, r.intent.operationID)]}
    },
    async stage(r) {
      await bound(r)
      const root = r.sourceIntent.path.replace(/\.intent\.json$/, ".runtime")
      let approved = false
      const result = await bridge(
        r.context,
        {mode: "stage", sourceIntent: r.sourceIntent, argv: r.argv, helper: input.helper, probe: input.probe},
        root,
        async (message) => {
          requireProof(
            !approved &&
              message.owner === r.intent.operationID &&
              same(message.argv, [
                "adb",
                "-t",
                r.source.transport,
                "shell",
                "am",
                "broadcast",
                "-a",
                "com.xy.updateota",
                "-p",
                "com.android.systemui",
                "--es",
                "cmd",
                "start",
                "--es",
                "pkname",
                "com.mentra.asg_client",
                "--es",
                "path",
                r.remote,
              ]),
            "Unexpected or repeated apply gate",
          )
          await r.beforeApply()
          const current = await closeSource(r.context, r.intent.operationID)
          await lease()
          await writeOnce(join(root, "apply-gate.json"), {
            owner: r.intent.operationID,
            sourceIntent: r.sourceIntent,
            writerIdentity: proofOf(current),
            argv: message.argv,
          })
          approved = true
        },
      )
      const evidence = await runtime.readStageEvidence({...r, outputDirectory: r.argv[r.argv.indexOf("--output") + 1]})
      requireProof(evidence && approved, `Missing original stage result; inspect ${result.evidence}`)
      return {...evidence, exitCode: result.exitCode}
    },
    async readStageEvidence(r) {
      await bound(r)
      const root = r.outputDirectory + ".runtime"
      try {
        const invocation = await json(join(root, "audit/invocation.json")),
          gate = await json(join(root, "apply-gate.json")),
          approved = await json(join(root, "audit/apply-approved.json")),
          start = await json(transferPath(r.context, r.intent.operationID))
        requireProof(
          invocation.owner === r.intent.operationID &&
            same(invocation.sourceIntent, r.sourceIntent) &&
            same(invocation.argv, r.argv) &&
            gate.owner === r.intent.operationID &&
            same(gate.sourceIntent, r.sourceIntent) &&
            same(gate.writerIdentity, start.writerIdentity) &&
            same(approved.sourceIntent, r.sourceIntent) &&
            approved.owner === r.intent.operationID &&
            same(approved.argv, gate.argv) &&
            same(start.source, r.source) &&
            same(start.sourceIntent, r.sourceIntent) &&
            start.remote === r.remote,
          "Original stage source/claim closure failed",
        )
        const preflight = await json(join(r.outputDirectory, "preflight.json")),
          receipt = await json(join(r.outputDirectory, "result.json")),
          broadcast = await json(join(r.outputDirectory, "broadcast.json"))
        requireProof(
          broadcast.returncode === 0 &&
            broadcast.stdout.includes("Broadcast completed") &&
            broadcast.log_boundary === receipt.log_boundary,
          "Original broadcast receipt mismatch",
        )
        let exitCode: number | null = null
        try {
          exitCode = (await json(join(root, "process/command.json"))).exitCode
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        return {
          exitCode,
          sourceIntent: r.sourceIntent,
          argv: r.argv,
          preflight,
          receipt,
          evidence: [root, r.outputDirectory, transferPath(r.context, r.intent.operationID)],
        } as MtkStageEvidence
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    },
    async reboot(r) {
      await bound(r)
      requireProof(
        same(r.argv, ["adb", "-t", r.source.transport, "reboot"]),
        "Only one selected-target reboot is permitted",
      )
      await r.beforeReboot()
      const stage = r.context.operations.find((op) => op.stepID === "restore-mtk-stage")
      requireProof(stage, "Activation needs original stage")
      await closeSource(r.context, stage.operationID)
      // Persist the old boot before the command; subsequent lifecycle reconciliation
      // performs independent reads and never sends another reboot.
      const intent = await writeOnce(join(r.context.runDirectory, `mtk-reboot-${r.intent.operationID}.json`), {
        owner: r.intent.operationID,
        source: r.source,
        sourceIntent: r.sourceIntent,
        argv: r.argv,
      })
      const result = await command(r.context, r.argv)
      const rec = await recorder(r.context),
        deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        try {
          const observed = await readOtaHardware(
            fixture,
            profiles.map((p) => p.mtk.version),
            profiles.map((p) => p.asg.versionCode),
            true,
            (argv) => rec.run(argv),
          )
          await rec.json(`boot-${randomUUID()}.json`, {
            bootId: observed.bootId,
            firmware: observed.firmware,
            slot: observed.slot,
          })
          if (observed.bootId !== r.source.bootId && observed.bootCompleted === "1") break
        } catch (error) {
          if (!(error instanceof OtaHardwareUnavailable)) throw error
        }
        await Bun.sleep(1000) // Observation only; never another activation command.
      }
      return {exitCode: result.exitCode, evidence: [intent.path, result.evidence]}
    },
  }
  return runtime
}
