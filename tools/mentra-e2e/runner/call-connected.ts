import {createHash} from "node:crypto"
import {createInterface} from "node:readline/promises"
import {Readable} from "node:stream"
import {stopOwnedProcess} from "./owned-process"
import {retireOwnedMeeting} from "./retire-call-meeting"
import {parseCallFixture, parseCallBuild, verifyCallDevice, hasInterfaceRoute, type CallFixture} from "./call-fixture"
import {selectUsbTransport} from "./ota-state"
import {recordedAction} from "./recorded-action"
import {executeSteps, waitFor, type Step} from "./suite"
import {appendFile, chmod, mkdir, copyFile, realpath} from "node:fs/promises"
import {join} from "node:path"
import {command, snapshot, root, type Doctor} from "./driver"
import {acquireLock, Report} from "./report"

export async function runConnectedCall(
  fixture: CallFixture,
  buildManifestPath: string,
  options: {browserRejoin?: boolean} = {},
) {
  // Detect an unprovisioned worktree before opening a call or changing hardware.
  await import("playwright-core").catch(() => {
    throw new Error("Browser dependency is unavailable; run bun install --frozen-lockfile in tools/mentra-e2e")
  })
  process.umask(0o077)
  const config = parseCallFixture(fixture)
  const expected = config.glasses
  const wifi = config.network.wifiInterface
  const ethernetInterface = config.network.ethernetInterface
  const manifest = parseCallBuild(await Bun.file(buildManifestPath).json())
  let here = ""
  let finalized = false
  let browserWatchdog: ReturnType<typeof setTimeout> | undefined
  let browserStop: Promise<void> | undefined
  let browserAbortHandler: (() => void) | undefined
  let pinnedBoot: string | undefined
  let inCleanup = false
  const abort = new AbortController()
  const cancel = () => abort.abort(new Error("Connected call replay cancelled"))
  const checkCancellation = () => {
    if (!inCleanup) abort.signal.throwIfAborted()
  }
  const context = {fixture: "USB-verified prejoined glasses", email: "", password: "", signal: abort.signal}
  const report = new Report("call-incoming-video", [])
  const release = await acquireLock()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  let transport = ""
  let hotspotOwned = false
  let password = ""
  let ssid = ""
  let wasSaved = true
  let logger: ReturnType<typeof Bun.spawn> | undefined
  let failed = false
  let browserChild: ReturnType<typeof Bun.spawn> | undefined
  let testBuildLaunched = false
  let miniappOwned = false
  let pcap: ReturnType<typeof Bun.spawn> | undefined
  let capturePid: string | undefined
  let captureStat: string | undefined
  let rootOwned = false
  let remoteCapture = ""
  let nativeLogger: ReturnType<typeof Bun.spawn> | undefined
  let audioDefaults: Record<string, {uid: string}> | undefined
  const redact = (s: string) => (password ? s.split(password).join("[REDACTED]") : s)
  const save = async (name: string, value: unknown) => {
    if (!here) throw new Error("Run evidence directory is not initialized")
    const path = join(here, name)
    await Bun.write(path, JSON.stringify(value, null, 2) + "\n")
    await chmod(path, 0o600)
  }
  async function cleanupFailure(name: string, error: unknown) {
    failed = true
    await save(name, {error: redact(String(error))}).catch(() =>
      console.error(`Could not write ${name}; cleanup continues`),
    )
  }
  async function run(args: string[], timeoutMs = 15000, allowFailure = false) {
    checkCancellation()
    const p = Bun.spawn(args, {stdout: "pipe", stderr: "pipe"})
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ])
      await appendFile(
        join(here, "commands.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          args: args.map(redact),
          code,
          stdout: redact(stdout),
          stderr: redact(stderr),
        }) + "\n",
        {mode: 0o600},
      )
      if (code && !allowFailure) throw new Error(`${args[0]} exited ${code}: ${redact(stderr || stdout).slice(0, 500)}`)
      return {stdout, stderr, code}
    } finally {
      clearTimeout(timer)
    }
  }
  const adb = (...args: string[]) => run(["adb", "-t", transport, ...args])
  async function identity() {
    const inventory = (await run(["adb", "devices", "-l"])).stdout
    transport = selectUsbTransport(inventory, expected.serial, expected.usb)
    const state: Record<string, string> = {transport}
    for (const [key, args] of Object.entries({
      cid: ["cat", "/sys/block/mmcblk0/device/cid"],
      firmware: ["getprop", "ro.custom.ota.version"],
      bootId: ["cat", "/proc/sys/kernel/random/boot_id"],
      slot: ["getprop", "ro.boot.slot_suffix"],
      serial: ["getprop", "ro.serialno"],
    })) {
      state[key] = (await adb("shell", ...args)).stdout.trim()
    }
    pinnedBoot = verifyCallDevice(expected, state, pinnedBoot)
    await appendFile(
      join(here, "identity-checks.jsonl"),
      JSON.stringify({at: new Date().toISOString(), ...state}) + "\n",
      {mode: 0o600},
    )
  }
  async function setHotspot(enabled: boolean) {
    await identity()
    // adb shell performs its own shell parsing; quote this known JSON as one argument.
    const json = JSON.stringify({type: "set_hotspot_state", enabled})
    await adb(
      "shell",
      "am",
      "broadcast",
      "-a",
      "com.mentra.asg_client.ACTION_SEND_COMMAND",
      "-n",
      "com.mentra.asg_client/.receiver.IntentCommandReceiver",
      "--es",
      "json",
      `'${json}'`,
    )
  }
  async function ethernet() {
    const route = (await run(["route", "-n", "get", "default"])).stdout
    if (!hasInterfaceRoute(route, ethernetInterface)) throw new Error("Ethernet is not the default internet route")
    const result = await run([
      "curl",
      "--interface",
      ethernetInterface,
      "--head",
      "--max-time",
      "10",
      "--silent",
      "--show-error",
      "https://teams.microsoft.com/",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
    ])
    if (!/^[23]\d\d$/.test(result.stdout)) throw new Error("Ethernet Teams HTTPS check failed")
  }
  async function step(id: string, instruction: string, expectedResult: string, fn: () => Promise<void>) {
    checkCancellation()
    try {
      await recordedAction(report, id, instruction, expectedResult, fn, snapshot, inCleanup)
    } catch (error) {
      failed = true
      throw error
    }
  }

  try {
    const initialDoctor = await command<Doctor>({op: "doctor"})
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await Bun.file(path).bytes())
        .digest("hex")
    if (
      (await hash(initialDoctor.executablePath)) !== manifest.executableSha256 ||
      !initialDoctor.javascriptPath ||
      (await hash(initialDoctor.javascriptPath)) !== manifest.javascriptSha256
    )
      throw new Error("Running Mentra differs from the declared installed build; no changes made")
    const initialState = await snapshot()
    if (
      initialState.elements.some((e) => e.visible && e.identifier === "miniapp.close") ||
      !initialState.elements.some((e) => e.visible && e.identifier === "home.miniapp.com.mentra.call")
    )
      throw new Error("Start the connected routine at Mentra home with no miniapp open")
    await report.start(
      initialDoctor,
      "USB-verified glasses; Ethernet internet; Mac-prejoined Wi-Fi; test-only adapter; native iPhone association untested",
      buildManifestPath,
    )
    here = join(report.directory, "setup")
    await mkdir(here, {mode: 0o700})
    const installedBundle = await realpath(join(manifest.launchPath, "WrappedBundle"))
    await run(["codesign", "--verify", "--strict", "-R", "=anchor apple generic", installedBundle])
    const executableName = (
      await run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleExecutable", join(installedBundle, "Info.plist")])
    ).stdout.trim()
    if (
      !/^[A-Za-z0-9_.-]+$/.test(executableName) ||
      (await hash(join(installedBundle, executableName))) !== manifest.executableSha256 ||
      (await hash(join(installedBundle, "main.jsbundle"))) !== manifest.javascriptSha256
    )
      throw new Error("Installed app differs from the declared running build; no hardware changes made")
    await save("installed-signature.json", {
      bundle: installedBundle,
      appleSignatureVerified: true,
      contentHashesMatched: true,
    })
    remoteCapture = "/data/local/tmp/mentra-e2e-" + report.directory.split("/").at(-1) + ".pcap"
    await save("fixture.json", config)
    const provenance: Record<string, string> = {}
    const inputs: Record<string, string> = {
      "controller.ts": import.meta.path,
      "retire-call-meeting.ts": join(import.meta.dir, "retire-call-meeting.ts"),
      "teams-browser.ts": join(root, "tools/mentra-e2e/teams-browser.ts"),
      "teams-browser-helpers.ts": join(import.meta.dir, "teams-browser.ts"),
      "browser-media-diagnostics.ts": join(import.meta.dir, "browser-media-diagnostics.ts"),
      "launch-with-network-lease.swift": join(root, "tools/mentra-e2e/native/helpers/LaunchWithNetworkLease.swift"),
      "launch-mentra.swift": join(root, "mobile/scripts/launch-ios-on-mac.swift"),
      "opening-steps.json": join(root, "tools/mentra-e2e/flows/call-connected-opening.json"),
      "build-manifest.json": buildManifestPath,
      "initial-build-manifest.json": buildManifestPath,
    }
    for (const [name, path] of Object.entries(inputs)) {
      await copyFile(path, join(here, name))
      provenance[name] = await hash(join(here, name))
    }
    for (const name of ["launch-with-network-lease", "launch-mentra"]) {
      await run(["xcrun", "swiftc", "-parse-as-library", join(here, name + ".swift"), "-o", join(here, name)], 60000)
      provenance[name] = await hash(join(here, name))
    }
    await save("controller-input-sha256.json", provenance)
    console.log("RUN_DIRECTORY " + report.directory)
    report.metadata.networkExperiment = {
      hypothesis: "the full product can reuse the exact macOS-established hotspot and reach Teams",
      productCallQualification: "pending",
      expected,
    }
    report.metadata.qualificationScope = "incoming video, admission, roster and owned cleanup; full call unqualified"
    report.metadata.duplexQualified = false
    report.metadata.executionMode = "deterministic-replay"
    report.metadata.modelCalls = 0
    report.metadata.controllerSha256 = createHash("sha256")
      .update(await Bun.file(import.meta.path).bytes())
      .digest("hex")
    report.metadata.networkAdapter = "mac-host-verified-test-only"
    report.metadata.nativeAssociationQualified = false
    report.metadata.testBuildManifest = await Bun.file(join(here, "build-manifest.json")).json()
    await report.startVideo()
    await step(
      "NET-01",
      "Verify the exact glasses and Ethernet internet before changing Wi-Fi.",
      "The fixture identity matches and Teams HTTPS is reachable through Ethernet.",
      async () => {
        await identity()
        await ethernet()
        const log = (await adb("logcat", "-d", "-t", "1500")).stdout
        const proof = log
          .split("\n")
          .filter((l) => l.includes("version_info_3") && l.includes(expected.bluetooth) && l.includes(expected.serial))
          .at(-1)
        if (!proof) throw new Error("No current USB log identity links the selected serial and Bluetooth address")
        await save("glasses-proof.json", {line: proof})
        const before = (
          await run(["adb", "-t", transport, "shell", "ip", "-4", "-o", "addr", "show", "dev", "ap0"], 15000, true)
        ).stdout
        if (/inet /.test(before)) throw new Error("Glasses hotspot is already active; this test does not own it")
        await save("mac-wifi-before.json", {
          power: (await run(["networksetup", "-getairportpower", wifi])).stdout,
          address: (await run(["ipconfig", "getifaddr", wifi], 15000, true)).stdout,
          currentNetwork: (await run(["networksetup", "-getairportnetwork", wifi])).stdout,
        })
      },
    )
    await step(
      "AUDIO-SETUP",
      "Inspect the selected glasses audio routes without changing the user’s selected devices.",
      "The exact BLE target is connected; available audio devices are recorded without selecting them. This incoming-video routine does not qualify return audio.",
      async () => {
        const paired = JSON.parse((await run(["blueutil", "--paired", "--format", "json"])).stdout)
        const target = paired.filter((d: any) => d.address.replaceAll("-", ":").toUpperCase() === expected.bluetooth)
        if (target.length !== 1 || !target[0].connected)
          throw new Error("The selected glasses are not connected over Bluetooth")
        await save("bluetooth.json", target)
        audioDefaults = {}
        for (const type of ["input", "output", "system"])
          audioDefaults[type] = JSON.parse((await run(["SwitchAudioSource", "-c", "-t", type, "-f", "json"])).stdout)
        await save("audio-defaults-before.json", audioDefaults)
        const devices = (await run(["SwitchAudioSource", "-a", "-f", "json"])).stdout
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s))
        await save("available-audio.json", {
          devices,
          returnAudioQualified: false,
          reason: "Incoming-video and roster run; audio selections are preserved, no duplex claim.",
        })
      },
    )
    const initialUser = (await adb("shell", "id")).stdout
    if (!initialUser.startsWith("uid=2000")) throw new Error("ADB was not originally shell; cannot claim ownership")
    await save("adb-user-before.json", {user: initialUser})
    rootOwned = true
    await adb("root")
    const rootDeadline = performance.now() + 20000
    while (true) {
      try {
        await identity()
        if (!(await adb("shell", "id")).stdout.startsWith("uid=0")) throw new Error("Waiting for root")
        break
      } catch (error) {
        if (performance.now() > rootDeadline) throw error
        await Bun.sleep(300)
      }
    }
    logger = Bun.spawn(
      [
        "adb",
        "-t",
        transport,
        "logcat",
        "-v",
        "threadtime",
        "-T",
        "1",
        "MentraBleTrace:I",
        "K900NetworkManager:I",
        "WhipStreamingService:V",
        "org.webrtc.Logging:V",
        "*:S",
      ],
      {stdout: Bun.file(join(here, "glasses-private.log")), stderr: Bun.file(join(here, "glasses-log-stderr.log"))},
    )
    let gateway = ""
    await step(
      "NET-02",
      "Start the glasses hotspot through its existing USB command.",
      "The glasses expose an IPv4 hotspot and report its network credentials.",
      async () => {
        hotspotOwned = true
        await setHotspot(true)
        for (let i = 0; i < 35; i++) {
          const state = await run(
            ["adb", "-t", transport, "shell", "ip", "-4", "-o", "addr", "show", "dev", "ap0"],
            10000,
            true,
          )
          gateway = /inet (\d+\.\d+\.\d+\.\d+)\/24/.exec(state.stdout)?.[1] ?? ""
          if (gateway) break
          await Bun.sleep(400)
        }
        if (!gateway) throw new Error("No glasses hotspot gateway appeared")
        ssid = (await adb("shell", "settings", "get", "global", "xy_ssid")).stdout.trim()
        // Do not route the secret-valued read through command transcript logging.
        const read = Bun.spawn(["adb", "-t", transport, "shell", "settings", "get", "global", "xy_pwd"], {
          stdout: "pipe",
          stderr: "pipe",
        })
        password = (await new Response(read.stdout).text()).trim()
        if ((await read.exited) || !password || password === "null" || !ssid || ssid === "null")
          throw new Error("Hotspot credentials are unavailable")
        report.secrets.push(password)
        await save("hotspot.json", {ssid, gateway, password: "[REDACTED]"})
        wasSaved = (await run(["networksetup", "-listpreferredwirelessnetworks", wifi])).stdout
          .split("\n")
          .some((l) => l.trim() === ssid)
      },
    )
    await step(
      "NET-03",
      "Join the glasses hotspot with macOS network controls.",
      "Wi-Fi obtains an address on the glasses subnet while Ethernet remains the default route.",
      async () => {
        await ethernet()
        const joined = await run(["networksetup", "-setairportnetwork", wifi, ssid, password], 30000, true)
        await save("macos-join-result.json", {
          code: joined.code,
          stdout: redact(joined.stdout),
          stderr: redact(joined.stderr),
        })
        if (joined.code || /error|failed|could not|unable/i.test(joined.stdout + " " + joined.stderr))
          throw new Error("macOS rejected hotspot association; see macos-join-result.json")
        let address = ""
        const prefix = gateway.split(".").slice(0, 3).join(".") + "."
        for (let i = 0; i < 40; i++) {
          address = (await run(["ipconfig", "getifaddr", wifi], 10000, true)).stdout.trim()
          if (address.startsWith(prefix) && address !== gateway) break
          await Bun.sleep(500)
        }
        if (!address.startsWith(prefix) || address === gateway)
          throw new Error("Wi-Fi did not obtain a glasses-subnet address")
        const route = (await run(["route", "-n", "get", gateway])).stdout
        if (!hasInterfaceRoute(route, wifi)) throw new Error("Glasses traffic is not routed through Wi-Fi")
        await ethernet()
        await save("macos-associated.json", {address, gateway, route})
      },
    )
    await step(
      "NET-04",
      "Read the glasses health endpoint over Wi-Fi.",
      "The glasses return healthy through the configured Wi-Fi interface; Ethernet still reaches Teams.",
      async () => {
        const result = await run([
          "curl",
          "--interface",
          wifi,
          "--max-time",
          "10",
          "--silent",
          "--show-error",
          "--fail",
          `http://${gateway}:8089/api/health`,
        ])
        await save("glasses-health.json", JSON.parse(result.stdout))
        if (JSON.parse(result.stdout).status !== "healthy") throw new Error("Unexpected health response")
        await ethernet()
      },
    )
    await step(
      "HOST-IDENTITY",
      "Match the hotspot gateway hardware address to the USB-verified glasses.",
      "The Ethernet internet route and Wi-Fi gateway belong to the selected fixture.",
      async () => {
        await identity()
        await ethernet()
        const expectedMac = (await adb("shell", "cat", "/sys/class/net/ap0/address")).stdout.trim().toLowerCase()
        const arp = (await run(["arp", "-n", gateway])).stdout
        const actual = new RegExp(` at ([0-9a-f:]+) on ${wifi}\\b`, "i").exec(arp)?.[1]
        const normalize = (mac: string) =>
          mac
            .split(":")
            .map((part) => part.padStart(2, "0"))
            .join(":")
            .toLowerCase()
        if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(expectedMac) || !actual || normalize(actual) !== expectedMac)
          throw new Error("Gateway MAC does not match the USB-verified glasses")
        await save("gateway-identity.json", {
          expectedMac,
          actualMac: normalize(actual),
          interface: wifi,
          usbSerial: expected.serial,
        })
      },
    )
    await step(
      "MEDIA-CAPTURE",
      "Capture only local traffic between this Mac and the verified glasses.",
      "A bounded capture on the glasses AP records WHIP and ICE for this test only.",
      async () => {
        await identity()
        if (!(await adb("shell", "id")).stdout.startsWith("uid=0"))
          throw new Error("Expected the test-owned root ADB session")
        if ((await run(["adb", "-t", transport, "shell", "pidof", "tcpdump"], 5000, true)).stdout.trim())
          throw new Error("Another packet capture is running; do not interfere")
        const address = (await Bun.file(join(here, "macos-associated.json")).json()).address
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new Error("Unexpected capture target")
        await adb("shell", "test", "!", "-e", remoteCapture)
        // exec-out merges remote stderr into stdout. Write the PCAP remotely so
        // tcpdump diagnostics cannot corrupt its binary header; use argv without shell punctuation.
        pcap = Bun.spawn(
          [
            "adb",
            "-t",
            transport,
            "exec-out",
            "timeout",
            "180",
            "tcpdump",
            "-i",
            "ap0",
            "-p",
            "-n",
            "-s",
            "0",
            "-U",
            "-w",
            remoteCapture,
            "host",
            address,
          ],
          {stdout: Bun.file(join(here, "tcpdump-private.log")), stderr: Bun.file(join(here, "tcpdump-adb-stderr.log"))},
        )
        const until = performance.now() + 5000
        while (true) {
          const ids = (await run(["adb", "-t", transport, "shell", "pidof", "tcpdump"], 5000, true)).stdout.trim()
          if (/^\d+$/.test(ids)) {
            capturePid = ids
            break
          }
          if (performance.now() > until) throw new Error("The scoped packet capture did not start")
          await Bun.sleep(150)
        }
        captureStat = (await adb("shell", "cat", `/proc/${capturePid}/stat`)).stdout
        await save("capture-owner.json", {
          pid: capturePid,
          processStat: captureStat,
          address,
          interface: "ap0",
          deadlineSeconds: 180,
          remoteCapture,
        })
      },
    )
    await step(
      "HOST-LEASE-LAUNCH",
      "Launch the test-only build with the freshly verified Mac network lease.",
      "The exact test binary returns to home. Native hotspot association is explicitly untested.",
      async () => {
        const joined = await Bun.file(join(here, "macos-associated.json")).json()
        const lease = {ssid, gateway, address: joined.address, issuedAt: Date.now() / 1000}
        await save("network-lease.json", lease)
        const manifest = await Bun.file(join(here, "build-manifest.json")).json()
        await report.video!.park()
        testBuildLaunched = true
        await run(
          [join(here, "launch-with-network-lease"), manifest.launchPath, join(here, "network-lease.json")],
          30000,
        )
        const until = performance.now() + 15000
        while (true) {
          try {
            await snapshot()
            break
          } catch (error) {
            if (performance.now() > until) throw error
            await Bun.sleep(150)
          }
        }
        await report.video!.reattach()
        const doctor = await command<Doctor>({op: "doctor"})
        const actual = createHash("sha256")
          .update(await Bun.file(doctor.executablePath).bytes())
          .digest("hex")
        if (actual !== manifest.executableSha256) throw new Error("Wrong test executable")
        await save("test-build-doctor.json", {...doctor, sha256: actual})
        const state = await snapshot()
        if (
          state.elements.some((e) => e.visible && e.role === "AXButton" && e.description === "Ignore") &&
          state.elements.some((e) => e.visible && e.description === "Glasses audio disconnected")
        ) {
          await command({op: "press", selector: {role: "AXButton", description: "Ignore"}})
        }
        await waitFor(
          [
            {selector: {identifier: "home.miniapp.com.mentra.call"}},
            {selector: {description: "Glasses audio disconnected"}, absent: true},
          ],
          15000,
        )
      },
    )
    const doctor = await command<Doctor>({op: "doctor"})
    await save("native-log-context.json", {
      pid: doctor.pid,
      executableSha256: manifest.executableSha256,
      startedAt: new Date().toISOString(),
      utcOffsetMinutes: new Date().getTimezoneOffset(),
    })
    nativeLogger = Bun.spawn(
      ["/usr/bin/log", "stream", "--style", "compact", "--level", "debug", "--predicate", `processID == ${doctor.pid}`],
      {stdout: Bun.file(join(here, "native-private.log")), stderr: Bun.file(join(here, "native-log-stderr.log"))},
    )
    const opening: Step[] = await Bun.file(join(here, "opening-steps.json")).json()
    let audioWarning = false
    await step(
      "CALL-LAUNCH-PREFLIGHT",
      "Open Call and distinguish its home from the known Classic-disconnected warning.",
      "Call home or the specific Mentra audio warning appears; no system dialog is handled.",
      async () => {
        miniappOwned = true
        await command({op: "press", selector: {identifier: "home.miniapp.com.mentra.call"}})
        const until = performance.now() + 15000
        while (true) {
          const current = await snapshot()
          audioWarning = current.elements.some((e) => e.visible && e.description === "Glasses audio disconnected")
          if (audioWarning || current.elements.some((e) => e.visible && e.description === "New Call Create a meeting."))
            break
          if (performance.now() > until) throw new Error("Call home and expected audio warning both absent")
          await Bun.sleep(150)
        }
      },
    )
    if (audioWarning) {
      await step(
        "AUDIO-IGNORE-FOR-ROSTER",
        "Choose Ignore for the explicitly declared BLE-only roster fixture.",
        "The audio warning closes; return audio remains excluded.",
        async () => {
          await command({op: "press", selector: {role: "AXButton", description: "Ignore"}})
          await waitFor([{selector: {description: "Glasses audio disconnected"}, absent: true}], 10000)
        },
      )
    } else opening[0].action = undefined

    if (!(await executeSteps(opening, context, report))) throw new Error("Call opening preflight failed")
    await save("meeting-attempt-start.json", {at: new Date().toISOString()})
    if (
      !(await executeSteps(
        [
          {
            id: "CALL-JOIN-ADMISSION",
            instruction:
              "Create one Direct link meeting immediately after verifying the hotspot and launching the same approved build.",
            expected:
              "The active call remains visible for fifteen seconds; this routine qualifies incoming video and roster updates.",
            action: {op: "press", selector: {role: "AXButton", description: "Create & Join"}},
            checks: [
              {selector: {role: "AXButton", description: "Leave the call", enabled: true}},
              {selector: {role: "AXHeading", description: "Couldn\u2019t start glasses camera"}, absent: true},
            ],
            timeoutMs: 45000,
            stableForMs: 15000,
            failOn: [
              {
                selector: {
                  role: "AXStaticText",
                  description: "Couldn’t reach Mentra Call. Check this phone’s internet connection and try again.",
                },
                message:
                  "The app could not reach the Mentra Call backend; inspect the recorded request failure before retrying.",
              },
              {
                selector: {role: "AXHeading", description: "Call limit reached"},
                message: "Daily Call quota exhausted; no automatic retry or quota modification.",
              },
              {
                selector: {role: "AXHeading", description: "Couldn’t start glasses camera"},
                message: "The app could not start the glasses camera.",
              },
            ],
          },
        ],
        context,
        report,
      ))
    )
      throw new Error("Immediate call join failed")
    await save("meeting-attempt-end.json", {at: new Date().toISOString()})
    async function ui(steps: Step[]) {
      if (!(await executeSteps(steps, context, report))) throw new Error("Recorded UI step failed")
    }
    const activeState = await snapshot()
    if (activeState.elements.some((e) => e.visible && e.description === "Glasses audio disconnected"))
      await ui([
        {
          id: "CALL-AUDIO-KNOWN",
          instruction: "Dismiss the declared Classic-disconnected warning for video and roster qualification.",
          expected: "The warning closes without changing any audio route.",
          action: {op: "press", selector: {role: "AXButton", description: "Ignore"}},
          checks: [{selector: {description: "Glasses audio disconnected"}, absent: true}],
        },
      ])
    await ui([
      {
        id: "CALL-QR",
        instruction: "Show the generated test meeting link.",
        expected: "The QR dialog opens.",
        action: {op: "press", selector: {role: "AXButton", description: "Show meeting QR code"}},
        checks: [{selector: {role: "AXButton", description: "Close QR code"}}],
      },
    ])
    const qr = await snapshot()
    const urls = [
      ...new Set(
        qr.elements
          .filter(
            (e) =>
              e.visible && e.role === "AXStaticText" && e.description?.startsWith("https://teams.microsoft.com/meet/"),
          )
          .map((e) => e.description),
      ),
    ]
    if (urls.length !== 1) throw new Error("Expected one generated meeting link")
    await Bun.write(join(here, "meeting-url.txt"), urls[0])
    await chmod(join(here, "meeting-url.txt"), 0o600)
    await ui([
      {
        id: "CALL-QR-CLOSE",
        instruction: "Close the meeting QR dialog.",
        expected: "Call controls return.",
        action: {op: "press", selector: {role: "AXButton", description: "Close QR code"}},
        checks: [{selector: {role: "AXButton", description: "View participants"}}],
      },
      {
        id: "CALL-PARTICIPANTS",
        instruction: "Open Participants before the browser guest joins.",
        expected: "The participant sheet shows an empty meeting.",
        action: {op: "press", selector: {role: "AXButton", description: "View participants"}},
        checks: [{selector: {role: "AXHeading", description: "0 participants"}}],
      },
    ])
    const browserFolder = join(report.directory, "browser")
    const browserScript = join(root, "tools/mentra-e2e/teams-browser.ts")
    report.metadata.browserControllerSha256 = createHash("sha256")
      .update(await Bun.file(browserScript).bytes())
      .digest("hex")
    const child = (browserChild = Bun.spawn(
      [
        "bun",
        browserScript,
        "run",
        "--meeting-url-file",
        join(here, "meeting-url.txt"),
        "--output",
        browserFolder,
        "--admission-seconds",
        "90",
        ...(options.browserRejoin ? ["--rejoin"] : []),
      ],
      {stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(here, "browser-stderr.log"))},
    ))
    const stopBrowser = () => {
      browserStop ??= stopOwnedProcess(child).catch((error) => cleanupFailure("browser-stop-error.json", error))
    }
    browserAbortHandler = stopBrowser
    browserWatchdog = setTimeout(() => {
      failed = true
      void save("browser-timeout.json", {error: "Browser companion exceeded four minutes"}).catch(() => {})
      stopBrowser()
    }, 240000)
    abort.signal.addEventListener("abort", stopBrowser, {once: true})
    const input = createInterface({input: Readable.fromWeb(child.stdout as any), crlfDelay: Infinity})
    let admitted = false
    for await (const line of input) {
      await appendFile(join(here, "browser-events.log"), line + "\n", {mode: 0o600})
      if (!line.startsWith("MENTRA_BROWSER_EVENT ")) continue
      const event = JSON.parse(line.slice("MENTRA_BROWSER_EVENT ".length))
      if (["browser-left", "recovery-left"].includes(event.id) && options.browserRejoin) {
        await ui([
          {
            id: event.id === "recovery-left" ? "CALL-DEPARTURE-BEFORE-RECOVERY" : "CALL-DEPARTURE-BEFORE-REJOIN",
            instruction: "Verify the browser guest has left before allowing it to rejoin.",
            expected: "The participant sheet remains at zero other participants.",
            checks: [
              {selector: {role: "AXHeading", description: "0 participants"}},
              {selector: {description: "Nobody else is in the call yet."}},
            ],
            timeoutMs: 15000,
            stableForMs: 1000,
          },
        ])
        admitted = false
        child.stdin.write("MENTRA_NATIVE_ACK browser-left\n")
        await child.stdin.flush()
      }
      const rejoining = event.id.startsWith("rejoin-") || event.id.startsWith("recovery-")
      if (event.phase === "lobby" && !admitted) {
        await ui([
          {
            id: event.id.startsWith("recovery-") ? "CALL-RECOVERY-ADMIT" : rejoining ? "CALL-READMIT" : "CALL-ADMIT",
            instruction: "Admit only the named Mentra E2E Observer from this replay.",
            expected: "The guest leaves the lobby through the capability-gated Admit control.",
            action: {op: "press", selector: {role: "AXButton", description: "Admit Mentra E2E Observer"}},
            checks: [
              {selector: {description: "Waiting in lobby"}, absent: true},
              {selector: {description: "Mentra E2E Observer"}},
            ],
            timeoutMs: 15000,
            stableForMs: 1000,
          },
        ])
        admitted = true
      }
      if (["initial-admitted", "rejoin-admitted", "recovery-admitted"].includes(event.id))
        await ui([
          {
            id: event.id.startsWith("recovery-")
              ? "CALL-ROSTER-RECOVERY"
              : rejoining
              ? "CALL-ROSTER-READMITTED"
              : "CALL-ROSTER-ADMITTED",
            instruction: "Verify the admitted browser guest remains in the native roster.",
            expected: "One guest is listed without a waiting label.",
            checks: [
              {selector: {role: "AXHeading", description: "1 participant"}},
              {selector: {description: "Mentra E2E Observer"}},
              {selector: {description: "Waiting in lobby"}, absent: true},
            ],
          },
        ])
    }
    const browserCode = await child.exited
    clearTimeout(browserWatchdog)
    abort.signal.removeEventListener("abort", stopBrowser)
    checkCancellation()
    await step(
      "BROWSER-RESULT",
      "Verify browser admission, decoded video and recorded cleanup.",
      "The zero-model browser routine passes and leaves the meeting; its continuous video has calibrated English chapters.",
      async () => {
        const result = await Bun.file(join(browserFolder, "result.json")).json()
        report.metadata.browserResult = result
        if (options.browserRejoin && result.rejoinQualified !== true)
          throw new Error("Browser rejoin was not qualified")
        if (browserCode !== 0 || result.status !== "incoming-video-passed" || result.cleanup !== "left")
          throw new Error("Browser companion failed; retained in browser/result.json")
      },
    )
    await ui([
      {
        id: "CALL-DEPARTURE",
        instruction: "Verify the browser participant has left.",
        expected: "The participant sheet returns to zero participants.",
        checks: [
          {selector: {role: "AXHeading", description: "0 participants"}},
          {selector: {description: "Nobody else is in the call yet."}},
        ],
        timeoutMs: 15000,
        stableForMs: 1000,
      },
      {
        id: "CALL-PARTICIPANTS-CLOSE",
        instruction: "Close Participants before ending this call.",
        expected: "The Leave control returns.",
        action: {op: "press", selector: {role: "AXButton", description: "Close participants"}},
        checks: [{selector: {role: "AXButton", description: "Leave the call"}}],
      },
      {
        id: "CALL-LEAVE",
        instruction: "Leave the test meeting in Mentra Call.",
        expected: "The app confirms You left the call.",
        action: {op: "press", selector: {role: "AXButton", description: "Leave the call"}},
        checks: [{selector: {role: "AXHeading", description: "You left the call"}}],
        timeoutMs: 15000,
      },
    ])
  } catch (error) {
    failed = true
    if (here) {
      await save("failure.json", {error: redact(String(error))})
      if (
        (await Bun.file(join(here, "meeting-attempt-start.json")).exists()) &&
        !(await Bun.file(join(here, "meeting-attempt-end.json")).exists())
      )
        await save("meeting-attempt-end.json", {at: new Date().toISOString()})
    }
    console.log(redact(String(error)))
  } finally {
    inCleanup = true
    try {
      if (here) {
        clearTimeout(browserWatchdog)
        if (browserAbortHandler) abort.signal.removeEventListener("abort", browserAbortHandler)
        await browserStop
        if (browserChild) {
          try {
            await stopOwnedProcess(browserChild)
          } catch (error) {
            await cleanupFailure("browser-cleanup-error.json", error)
          }
        }
        try {
          if (miniappOwned) {
            let state = await snapshot()
            for (const label of ["Close QR code", "Close participants"])
              if (state.elements.some((e) => e.visible && e.role === "AXButton" && e.description === label)) {
                await command({op: "press", selector: {role: "AXButton", description: label}})
                state = await snapshot()
              }
            if (state.elements.some((e) => e.visible && e.description === "Leave the call"))
              await step(
                "CALL-FAILURE-LEAVE",
                "Leave the owned call during failure cleanup.",
                "The app confirms You left the call.",
                async () => {
                  await command({op: "press", selector: {role: "AXButton", description: "Leave the call"}})
                  await waitFor([{selector: {role: "AXHeading", description: "You left the call"}}], 15000)
                },
              )
            state = await snapshot()
            if (state.elements.some((e) => e.identifier === "miniapp.close" && e.visible))
              await step(
                "CALL-CLOSE",
                "Close the test miniapp before network cleanup.",
                "Mentra home returns.",
                async () => {
                  await command({op: "press", selector: {identifier: "miniapp.close"}})
                },
              )
          }
        } catch (error) {
          await cleanupFailure("close-error.json", error)
        }
        if (testBuildLaunched) {
          try {
            await step(
              "APP-RESTORE",
              "Reset the same fixed test build without a network lease.",
              "The fixed test executable and authenticated home return; no new build is installed.",
              async () => {
                const manifest = await Bun.file(join(here, "initial-build-manifest.json")).json()
                await report.video!.park()
                await run([join(here, "launch-mentra"), manifest.launchPath], 30000)
                const until = performance.now() + 15000
                while (true) {
                  try {
                    await snapshot()
                    break
                  } catch (error) {
                    if (performance.now() > until) throw error
                    await Bun.sleep(150)
                  }
                }
                await report.video!.reattach()
                await waitFor([{selector: {identifier: "home.miniapp.com.mentra.call"}}], 15000)
                const doctor = await command<Doctor>({op: "doctor"})
                const actual = createHash("sha256")
                  .update(await Bun.file(doctor.executablePath).bytes())
                  .digest("hex")
                if (actual !== manifest.executableSha256) throw new Error("Restored executable hash mismatch")
                await save("restored-doctor.json", {...doctor, sha256: actual})
              },
            )
          } catch (error) {
            await cleanupFailure("restore-error.json", error)
          }
        }
        if (hotspotOwned) {
          try {
            await step(
              "NET-CLEANUP",
              "Stop the test hotspot and verify restoration.",
              "The exact glasses hotspot stops; Ethernet internet remains available.",
              async () => {
                await setHotspot(false)
                let active = true
                for (let i = 0; i < 30; i++) {
                  active = /inet /.test(
                    (
                      await run(
                        ["adb", "-t", transport, "shell", "ip", "-4", "-o", "addr", "show", "dev", "ap0"],
                        10000,
                        true,
                      )
                    ).stdout,
                  )
                  if (!active) break
                  await Bun.sleep(400)
                }
                if (active) throw new Error("Glasses hotspot did not stop")
                if (ssid && !wasSaved) await run(["networksetup", "-removepreferredwirelessnetwork", wifi, ssid])
                await ethernet()
                await save("cleanup.json", {
                  hotspotStopped: true,
                  removedOnlyNewTestPreference: !!ssid && !wasSaved,
                  macWifiAddress: (await run(["ipconfig", "getifaddr", wifi], 10000, true)).stdout.trim(),
                  defaultRoute: (await run(["route", "-n", "get", "default"])).stdout,
                })
              },
            )
          } catch (error) {
            await cleanupFailure("cleanup-error.json", error)
          }
        }
        if (audioDefaults)
          try {
            const after: Record<string, {uid: string}> = {}
            for (const type of Object.keys(audioDefaults))
              after[type] = JSON.parse((await run(["SwitchAudioSource", "-c", "-t", type, "-f", "json"])).stdout)
            const defaultsUnchanged = Object.keys(audioDefaults).every(
              (type) => audioDefaults![type].uid === after[type].uid,
            )
            if (!defaultsUnchanged) failed = true
            await save("audio-preserved.json", {
              defaultsUnchanged,
              before: audioDefaults,
              after,
              mutations: 0,
              note: "User choices preserved; this routine never selects audio devices.",
            })
          } catch (error) {
            await cleanupFailure("audio-observation-error.json", error)
          }
        if (nativeLogger)
          try {
            await stopOwnedProcess(nativeLogger, "SIGINT")
            await chmod(join(here, "native-private.log"), 0o600)
          } catch (error) {
            await cleanupFailure("native-logger-cleanup-error.json", error)
          }
        if (capturePid) {
          try {
            await identity()
            const current = (
              await run(["adb", "-t", transport, "shell", "cat", `/proc/${capturePid}/stat`], 5000, true)
            ).stdout
            const startTime = (line: string) => line.slice(line.lastIndexOf(")") + 2).split(" ")[19]
            if (current && captureStat && startTime(current) === startTime(captureStat))
              await adb("shell", "kill", "-INT", capturePid)
            if (pcap) {
              await Promise.race([pcap.exited, Bun.sleep(3000)])
              pcap.kill()
            }
            const localCapture = join(here, "glasses-media-private.pcap")
            await adb("pull", remoteCapture, localCapture)
            await chmod(localCapture, 0o600)
            const bytes = await Bun.file(localCapture).bytes()
            const magic = Buffer.from(bytes.slice(0, 4)).toString("hex")
            if (bytes.length < 24 || !["d4c3b2a1", "a1b2c3d4", "4d3cb2a1", "a1b23c4d"].includes(magic))
              throw new Error("Invalid packet capture")
            const localHash = createHash("sha256").update(bytes).digest("hex")
            const remoteHash = (await adb("shell", "sha256sum", remoteCapture)).stdout.split(/\s+/)[0]
            if (remoteHash !== localHash) throw new Error("Packet capture copy differs from the device")
            await save("packet-capture.json", {
              path: localCapture,
              bytes: bytes.length,
              sha256: localHash,
              scopedTo: "Mac and verified glasses only",
            })
            await adb("shell", "rm", remoteCapture)
          } catch (error) {
            await cleanupFailure("capture-cleanup-error.json", error)
          }
        }
        if (rootOwned)
          try {
            await identity()
            await adb("unroot")
            const until = performance.now() + 20000
            while (true) {
              try {
                await identity()
                break
              } catch (error) {
                if (performance.now() > until) throw error
                await Bun.sleep(300)
              }
            }
            const user = (await adb("shell", "id")).stdout
            if (!user.startsWith("uid=2000")) throw new Error("ADB did not return to the original shell user")
            await save("adb-restoration.json", {user, restored: true})
          } catch (error) {
            await cleanupFailure("adb-restoration-error.json", error)
          }
        if (logger)
          try {
            await stopOwnedProcess(logger, "SIGINT")
            await chmod(join(here, "glasses-private.log"), 0o600)
          } catch (error) {
            await cleanupFailure("glasses-logger-cleanup-error.json", error)
          }
        if (await Bun.file(join(here, "meeting-attempt-start.json")).exists()) {
          try {
            if (!(await Bun.file(join(here, "meeting-attempt-end.json")).exists()))
              await save("meeting-attempt-end.json", {at: new Date().toISOString()})
            await retireOwnedMeeting(here, config.cleanup)
          } catch (error) {
            await cleanupFailure("meeting-cleanup-error.json", error)
          }
        }
        if (report.directory) {
          const nativeLog = (await Bun.file(join(here, "native-private.log")).exists())
            ? await Bun.file(join(here, "native-private.log")).text()
            : ""
          const permissionDenials = nativeLog.split("\n").filter((line) => line.includes("Local network prohibited"))
          report.metadata.localNetworkPermission = {
            denials: permissionDenials.length,
            automaticChecksPassed: !failed && permissionDenials.length === 0,
            permissionPersistenceQualified: false,
            note: "No denial alone does not establish unattended operation or persistence. Record any human interventions and qualify repeated runs separately.",
          }
          await save("permission-qualification.json", report.metadata.localNetworkPermission)
          if (permissionDenials.length) failed = true
          await report.finish(
            failed ? "failed" : "passed",
            "Deterministic incoming-video and participant routine. Cleanup and exact meeting retirement are in setup/. Duplex and native iPhone association remain unqualified. Location remains off; fixed app identity reused.",
          )
          finalized = true
          await save("run-location.json", {directory: report.directory})
        }
      }
    } finally {
      clearTimeout(browserWatchdog)
      if (!finalized && report.directory) {
        failed = true
        await report
          .finish("failed", "Setup or cleanup was interrupted; retained evidence is incomplete.")
          .catch((error) => console.error(`Could not finalize evidence: ${redact(String(error))}`))
      }
      process.off("SIGINT", cancel)
      process.off("SIGTERM", cancel)
      await release()
    }
  }
  return {directory: report.directory, status: failed || report.metadata.status !== "passed" ? "failed" : "passed"}
}
