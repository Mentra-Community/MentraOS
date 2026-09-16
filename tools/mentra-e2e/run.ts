import {parseArgs} from "node:util"
import {buildDriver, command, compact, snapshot, type Doctor} from "./runner/driver"
import {acquireLock, Report} from "./runner/report"
import {executeSteps} from "./runner/suite"
import {driverProof} from "./flows/driver-proof"
import {login} from "./flows/login"
import {credentials} from "./runner/credentials"
import {onboarding} from "./flows/onboarding"
import {discover} from "./runner/discover"
import {accessibilityPreflight} from "./flows/accessibility-preflight"
import {lifecycleProof} from "./flows/lifecycle-proof"
import {noGlasses, noGlassesExclusions} from "./flows/no-glasses"
import {recoverUnpaired} from "./runner/recovery"
import {failureProof} from "./flows/failure-proof"
import {mentraCallIosAvailability} from "./flows/mentra-call-ios-availability"

const {positionals, values} = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "suite": {type: "string", default: "driver-proof"},
    "fixture": {type: "string", default: "unpaired"},
    "build-manifest": {type: "string"},
  },
})
const operation = positionals[0] ?? "doctor"
try {
  if (operation !== "describe") await buildDriver()
  if (operation === "describe") {
    const callAvailability = values.suite === "mentra-call-ios-availability"
    console.log(
      callAvailability
        ? "# Mentra Call iOS availability routine\n\nHost policy check only; Call UI and real calling are not covered. Start signed in on English, unpaired home. Each numbered action/check has its own screenshot and video chapter.\n"
        : "# Compiled no-glasses routine\n\nGenerated from `flows/no-glasses.ts`. Start signed in on English, unpaired home. Credentials are requested at runtime. Each numbered action/check has its own screenshot and video chapter.\n",
    )
    console.log(
      (callAvailability ? mentraCallIosAvailability : noGlasses)
        .map((step, index) => `${index + 1}. **${step.id}** ${step.instruction} Expected: ${step.expected}`)
        .join("\n"),
    )
    if (!callAvailability) {
      console.log("\nDeclared exclusions:\n")
      console.log(
        noGlassesExclusions.map((step) => `- **${step.id} — ${step.instruction}:** ${step.reason}`).join("\n"),
      )
    }
  } else if (operation === "doctor") {
    const doctor = await command<Doctor>({op: "doctor"})
    console.log(JSON.stringify(doctor, null, 2))
    if (!doctor.accessibility || !doctor.screenCapture) process.exitCode = 2
  } else if (operation === "inspect") {
    console.log(JSON.stringify(compact(await snapshot()), null, 2))
  } else if (operation === "discover") {
    await discover(values.fixture!, values["build-manifest"])
  } else if (operation === "run") {
    const suites = {
      "driver-proof": driverProof,
      login,
      onboarding,
      "accessibility-preflight": accessibilityPreflight,
      "lifecycle-proof": lifecycleProof,
      "no-glasses": noGlasses,
      "failure-proof": failureProof,
      "mentra-call-ios-availability": mentraCallIosAvailability,
      "restore-unpaired": [],
    }
    const steps = suites[values.suite as keyof typeof suites]
    if (!steps) throw new Error(`Suite is not implemented: ${values.suite}`)
    if (
      ["no-glasses", "failure-proof", "restore-unpaired", "mentra-call-ios-availability"].includes(values.suite!) &&
      values.fixture !== "unpaired"
    )
      throw new Error("This suite requires the declared unpaired fixture")
    const account = ["login", "no-glasses", "failure-proof", "restore-unpaired"].includes(values.suite!)
      ? await credentials()
      : {email: "", password: ""}
    const release = await acquireLock()
    const report = new Report(values.suite!, [account.password])
    try {
      const doctor = await command<Doctor>({op: "doctor"})
      await report.start(doctor, values.fixture!, values["build-manifest"])
      if (!doctor.accessibility || !doctor.screenCapture)
        throw new Error("macOS Accessibility and Screen Recording permissions are required; run doctor")
      await report.startVideo()
      const context = {...account, fixture: values.fixture!}
      const passed =
        values.suite === "restore-unpaired"
          ? await recoverUnpaired(context, report)
          : await executeSteps(steps, context, report)
      let recovery: boolean | undefined
      if (
        !passed &&
        ["no-glasses", "failure-proof"].includes(values.suite!) &&
        report.results.some((step) => step.id === "PRE-01" && step.status === "passed")
      ) {
        recovery = await recoverUnpaired({...account, fixture: values.fixture!}, report).catch(async (error) => {
          await report.record(
            {
              id: "RECOVERY-error",
              instruction: "Restore the test fixture.",
              expected: "Signed-in unpaired home is restored.",
              status: "failed",
              durationMs: 0,
              error: String(error),
            },
            await snapshot().catch(() => undefined),
          )
          return false
        })
        report.metadata.recovery = {status: recovery ? "passed" : "failed"}
      }
      if (values.suite === "no-glasses") {
        for (const excluded of noGlassesExclusions)
          await report.record({...excluded, expected: excluded.reason, status: "not-applicable", durationMs: 0})
      }
      const restored =
        values.suite === "mentra-call-ios-availability"
          ? "iOS host exclusion verified; search cleared and unpaired home restored. Call UI and real calling were not exercised."
          : values.suite === "driver-proof"
            ? "Authentication start restored"
            : values.suite === "accessibility-preflight"
              ? "No UI changes; inspected the current miniapp"
              : values.suite === "no-glasses"
                ? "Signed-in unpaired home verified; test overlays closed; no preference changes made"
                : "Authenticated app reached"
      await report.finish(
        passed ? "passed" : "failed",
        passed
          ? restored
          : recovery === true
            ? "Original failure retained; signed-in unpaired home restored"
            : recovery === false
              ? "Original failure retained; recovery also failed—inspect its separate evidence"
              : "No UI recovery attempted; inspect failure evidence",
      )
      if (!passed || report.metadata.status !== "passed") process.exitCode = 1
    } catch (error) {
      if (report.directory) await report.finish("incomplete", `Setup/run failure: ${String(error)}`)
      throw error
    } finally {
      await release()
    }
  } else throw new Error(`Unknown command: ${operation}`)
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
}
