import type {Snapshot} from "./driver"
import type {readOtaHardware} from "./ota-hardware"
import {otaPage} from "./ota-state"
import type {Step} from "./suite"

export interface OtaCustomerProgress {
  started: boolean
  installPasses: number
  finished: boolean
}

export interface OtaCustomerSelection {
  install: boolean
  resume: boolean
  minutes: number
  before: {bootId: string; slot: string}
  target: {asgVersion: number; firmware: string; bes: string}
}

type Hardware = Awaited<ReturnType<typeof readOtaHardware>>
export interface OtaCustomerActions {
  snapshot(): Promise<Snapshot>
  hardware(observingActivePass?: boolean): Promise<Hardware>
  /** Must read a fresh BES proof from this independently identified boot. */
  readBesVersion(hardware: Hardware): Promise<string>
  observe(instruction: string, state: Snapshot): Promise<void>
  executeStep(step: Omit<Step, "id">): Promise<boolean>
  press(identifier: string, instruction: string): Promise<void>
  verifyAppPair(): Promise<void>
  verifyTarget(): Promise<void>
  verifyPublishedManifests?(): Promise<void>
  /** Preserve transport/boot downtime evidence; identity or command failures remain fatal. */
  observeHardware(observingActivePass: boolean): Promise<void>
}

/**
 * The existing customer loop only. The caller owns the lease, lifecycle intent,
 * report/step IDs, fresh hardware gates and cleanup. This function acquires no
 * resources and never starts another lifecycle or retries a failed UI action.
 * Progress remains available after errors for the owning lifecycle to reconcile.
 */
export async function runOtaCustomerSequence(
  selection: OtaCustomerSelection,
  progress: OtaCustomerProgress,
  metadata: Record<string, unknown>,
  actions: OtaCustomerActions,
  clock = {now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms)},
) {
  const {install, resume, minutes, target} = selection
  const {snapshot, hardware, observe, executeStep, press, verifyAppPair, verifyTarget} = actions
  const before = await hardware(
    resume && ["working", "checking", "pass-complete"].includes(otaPage(await snapshot()).kind),
  )
  // ASG and MTK can stay unchanged in a BES-only release. Require a fresh BES
  // response before deciding to skip the app's normal installation flow.
  let alreadyCurrent = false
  if (!resume && before.asgVersion === target.asgVersion && before.firmware === target.firmware)
    alreadyCurrent = (await actions.readBesVersion(before)) === target.bes
  if (
    !alreadyCurrent &&
    !resume &&
    (before.bootId !== selection.before.bootId || before.slot !== selection.before.slot)
  )
    throw new Error("Initial boot or slot differs from the reviewed fixture")
  await observe("Verify the app's OTA pin and exact fixture identity before any installation.", await snapshot())
  if (!resume) {
    const initialPage = otaPage(await snapshot())
    if (initialPage.kind === "offered") {
      const ok = await executeStep({
        instruction: "Defer the update offer briefly to verify the paired device.",
        expected: "The offer closes without starting installation.",
        action: {op: "press", selector: {role: "AXButton", description: "Later"}},
        checks: [{selector: {role: "AXButton", description: "Install"}, absent: true}],
      })
      if (!ok) throw new Error("Could not reach home for pairing verification")
    } else if (initialPage.kind !== "home")
      throw new Error("Start a new OTA routine at paired home or its initial update offer")
    await verifyAppPair()
    if (install && !alreadyCurrent) {
      const ok = await executeStep({
        instruction: "Relaunch the same signed app to repeat its normal update check.",
        expected: "The same app relaunches; the observer handles home, checking and update offers.",
        action: {op: "relaunch"},
        checks: [],
        timeoutMs: 20000,
      })
      if (!ok) throw new Error("Same-build OTA check relaunch failed")
    }
  }
  const deadline = clock.now() + minutes * 60000
  let lastPage = ""
  let unknownSince = clock.now()
  let lastHardwareCheck = clock.now()
  while (clock.now() < deadline) {
    const state = await snapshot()
    const page = otaPage(state)
    if (page.title !== lastPage) {
      await observe(`Observe OTA: ${page.title || "transitioning"}.`, state)
      console.log(`OTA: ${page.kind} — ${page.title}`)
      lastPage = page.title
    }
    if (page.kind === "failed") throw new Error(`OTA stopped on ${page.title}; app and glasses left untouched`)
    if (
      page.kind === "complete" ||
      page.kind === "current" ||
      (page.kind === "home" && alreadyCurrent && !progress.started)
    ) {
      await verifyTarget()
      if (page.kind !== "home")
        await press(
          page.kind === "complete" ? "button-Done" : "button-Continue",
          "Finish the verified update and return to paired home.",
        )
      if (otaPage(await snapshot()).kind !== "home") throw new Error("Verified update did not return to home")
      if (resume || progress.started) await verifyAppPair()
      metadata.otaOutcome = progress.started ? "updated" : resume ? "resumed-and-verified" : "already-current"
      progress.finished = true
      break
    }
    if (page.kind === "pass-complete") {
      if (!progress.started && !resume)
        throw new Error("An existing update completed; use --resume to finish observing it")
      await press(page.finishControl!, "Finish this installation pass and let the app check for remaining updates.")
    } else if (page.kind === "offered") {
      if (!install || resume) throw new Error("An update is offered; --install is required to start a new update")
      const ok = await executeStep({
        instruction: "Open the offered Mentra Live update.",
        expected: "Update Now is available.",
        action: {op: "press", selector: {role: "AXButton", description: "Install", enabled: true}},
        checks: [{selector: {identifier: "button-Update Now", enabled: true}}],
        timeoutMs: 30000,
      })
      if (!ok) throw new Error("Update offer did not open")
    } else if (page.kind === "available") {
      if (!install || resume) throw new Error("--install is required to start an update pass")
      // Match the app's eight-pass auto-chain bound; every pass retains the same pinned targets.
      if (progress.installPasses >= 8) throw new Error("Pinned OTA sequence exceeded eight installation passes")
      await actions.verifyPublishedManifests?.()
      await hardware()
      progress.started = true
      metadata.installPasses = ++progress.installPasses
      await press(
        "button-Update Now",
        `Start pass ${progress.installPasses} of the pinned OTA sequence through the Mentra App.`,
      )
    } else if (page.kind === "working") {
      if (!progress.started && !resume) throw new Error("An existing update is active; use --resume to observe it")
    }
    if (page.kind !== "unknown") unknownSince = clock.now()
    else if (clock.now() - unknownSince > 60000) throw new Error("Unrecognized OTA screen persisted for 60 seconds")
    if (clock.now() - lastHardwareCheck > 5000) {
      await actions.observeHardware(
        (progress.started || resume) && ["working", "checking", "pass-complete"].includes(page.kind),
      )
      lastHardwareCheck = clock.now()
    }
    await clock.sleep(750)
  }
  if (!progress.finished)
    throw new Error("OTA observation deadline reached; installation was not interrupted or retried")
}
