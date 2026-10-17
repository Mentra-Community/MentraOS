import assert from "node:assert/strict"
import test from "node:test"
import {mkdtemp, mkdir, readFile, rm, writeFile, symlink, chmod, rename, realpath} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {ANDROID_PUBLICATION_STEP, androidAppIdentity, androidReceiptName, publishAndroidArtifacts, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {inspectNimoDiagnosticBytecode, resolveAndroidSdkAnalyzer, validateNimoDiagnosticBytecode, NIMO_DIAGNOSTIC, NIMO_RECEIVER, NIMO_MANAGER, NIMO_SDK, NIMO_DEVICE} from "./pr-android-artifacts-diagnostic.mjs"
import {runInNewContext} from "node:vm"
import {artifactUrl} from "./release-artifact-storage.mjs"


const desc = name => `L${name.replaceAll('.', '/')};`
const diagnosticCode = {
 diagnostics:`.class public final ${desc(NIMO_DIAGNOSTIC)}
.method public final start(Landroid/content/Context;)V
 const-string v0, "com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE"
 invoke-direct {v3, v0}, Landroid/content/IntentFilter;-><init>(Ljava/lang/String;)V
 const-string v1, "android.permission.DUMP"
 sget-object v2, ${desc(NIMO_DIAGNOSTIC)}->receiver:${desc(NIMO_RECEIVER)}
 invoke-virtual {v0, v2}, Landroid/content/Context;->registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;)Landroid/content/Intent;
.end method
.method static constructor <clinit>()V
 new-instance v0, ${desc(NIMO_RECEIVER)}
 invoke-direct {v0}, ${desc(NIMO_RECEIVER)}-><init>()V
.end method
`,
 receiver:`.class public final ${desc(NIMO_RECEIVER)}
.super Landroid/content/BroadcastReceiver;
.method public onReceive(Landroid/content/Context;Landroid/content/Intent;)V
 const-string v0, "com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE"
 invoke-virtual {v0, v1}, ${desc(NIMO_DIAGNOSTIC)}->execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V
.end method
`,
 manager:`.class public final ${desc(NIMO_MANAGER)}
.method public constructor <init>()V
 invoke-virtual {v0, v1}, ${desc(NIMO_DIAGNOSTIC)}->start(Landroid/content/Context;)V
.end method
`}


const hookArgs = name => name === 'dispatchCapturedEntry' ? 'Lkotlin/jvm/functions/Function0;' : ['allowManagerConnect','preserveCapturedScan'].includes(name) ? 'Ljava/lang/String;Ljava/lang/String;' : `${desc(NIMO_DEVICE)}Ljava/lang/String;Z`
const guardedMethod = (signature, guards) => `.method public final ${signature}\n${guards.map(name=>` invoke-virtual {v0}, ${desc(NIMO_DIAGNOSTIC)}->${name}(${hookArgs(name)})Z\n move-result v0\n if-eqz v0, :continue\n return-void\n :continue`).join('\n')}\n.end method\n`
diagnosticCode.diagnostics += `.method public execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V
 const-string v0, "arm-capture"
 const-string v0, "capture-status"
 const-string v0, "cancel-capture"
 invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->releaseCapturedResource$bluetooth_sdk_nimoDiagnostic(Lkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;)V
.end method
.method private captureSnapshot(Lcom/mentra/bluetoothsdk/sgcs/NimoResourceDiagnostics$Capture;)Lorg/json/JSONObject;
 const-string v0, "nimo-preconnect-capture-v1"
.end method
.method public dispatchCapturedEntry(Lkotlin/jvm/functions/Function0;)Z
 invoke-virtual {v0}, Landroid/os/Handler;->post(Ljava/lang/Runnable;)Z
 invoke-virtual {v0}, Ljava/util/concurrent/FutureTask;->get()Ljava/lang/Object;
 invoke-virtual {v0}, Ljava/util/concurrent/FutureTask;->cancel(Z)Z
.end method
`
diagnosticCode.sdk = `.class public final ${desc(NIMO_SDK)}\n` + [
 'connect(Lcom/mentra/bluetoothsdk/Device;Lcom/mentra/bluetoothsdk/ConnectOptions;)V',
 'connectDefault(Lcom/mentra/bluetoothsdk/ConnectOptions;)V',
 'startScan(Lcom/mentra/bluetoothsdk/DeviceModel;)V',
].map(sig=>guardedMethod(sig,['dispatchCapturedEntry','allowManagerConnect',...(sig.startsWith('startScan(')?[]:['preserveCapturedScan'])])).join('')
diagnosticCode.manager += ['connectByName(Ljava/lang/String;)V','connectDefault()V'].map(sig=>guardedMethod(sig,['dispatchCapturedEntry','allowManagerConnect',...(sig.startsWith('connectByName(')?['preserveCapturedScan']:[])])).join('')
diagnosticCode.nimo = `.class public final ${desc(NIMO_DEVICE)}\n` + [
 ['connectById(Ljava/lang/String;)V',['dispatchCapturedEntry','admit']],
 ['findCompatibleDevices()V',['dispatchCapturedEntry','admit']],
 ['connectCompanionGatt(Landroid/bluetooth/BluetoothDevice;)V',['allowPeer']],
 ['startBond(Landroid/bluetooth/BluetoothDevice;)V',['allowPeer']],
 ['connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V',['beginTransport']],
].map(([sig,guards])=>guardedMethod(sig,guards)).join('')
const policy = 'preArmCaptureRequired$bluetooth_sdk_nimoDiagnostic'
const policyDefault = `${policy}$default(${desc(NIMO_DIAGNOSTIC)}Ljava/lang/String;ILjava/lang/Object;)Z`
const resultCall = reference => ` invoke-virtual {v0}, ${reference}\n move-result v0\n return v0\n`
diagnosticCode.diagnostics = diagnosticCode.diagnostics.replace('const-string v0, "nimo-preconnect-capture-v1"', `const-string v0, "nimo-preconnect-capture-v1"\n const-string v1, "captureRequiredBeforeArm"\n${resultCall(`${desc(NIMO_DIAGNOSTIC)}->${policyDefault}`).replace('return v0', 'invoke-virtual {v2, v1, v0}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;')}`)
diagnosticCode.diagnostics += `.method public ${policy}(Ljava/lang/String;)Z
 const-string v0, "nimoDiagnostic"
${resultCall('Lkotlin/jvm/internal/Intrinsics;->areEqual(Ljava/lang/Object;Ljava/lang/Object;)Z')}.end method
.method public static ${policyDefault}
 const-string v0, "nimoDiagnostic"
${resultCall(`${desc(NIMO_DIAGNOSTIC)}->${policy}(Ljava/lang/String;)Z`)}.end method
.method public allowUnarmedWearable$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;Ljava/lang/String;)Z
 const-string v1, "NIMO"
${resultCall(`${desc(NIMO_DIAGNOSTIC)}->${policy}(Ljava/lang/String;)Z`)}.end method
.method public allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z
 const-string v0, "nimoDiagnostic"
${resultCall(`${desc(NIMO_DIAGNOSTIC)}->allowUnarmedWearable$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;Ljava/lang/String;)Z`)}.end method
` + ['admit','allowPeer','beginTransport'].map(name=>`.method public ${name}(${desc(NIMO_DEVICE)}Ljava/lang/String;Z)Z\n${resultCall(`${desc(NIMO_DIAGNOSTIC)}->${policyDefault}`)}.end method\n`).join('')

// Representative compiler ABI for v3 clock-producing methods and call wiring.
diagnosticCode.diagnostics += `.method private clockReceipt()Lorg/json/JSONObject;
 const-string v0, "nimo-monotonic-receipt-v1"
 const-string v0, "android-elapsed-realtime-v1"
 const-string v0, "requestReceivedElapsedMs"
 invoke-static {}, Landroid/os/SystemClock;->elapsedRealtime()J
 invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->resourceCaptureAdmission$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;JJ)V
 invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->releaseCapturedResource$bluetooth_sdk_nimoDiagnostic(Lkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J)V
.end method
`
diagnosticCode.nimo += `.method public resourceSnapshot$bluetooth_sdk_nimoDiagnostic()Lorg/json/JSONObject;
 invoke-static {}, Landroid/os/SystemClock;->elapsedRealtime()J
${['observedElapsedMs','captureNonce','armedElapsedMs','admittedElapsedMs','sessionStartedElapsedMs','releaseNonce','releaseStartedElapsedMs','firmwareElapsedMs','twsElapsedMs','handshakeTwsElapsedMs','timeWriteStartedElapsedMs','timeAckElapsedMs','micStopStartedElapsedMs','micStopMarkerElapsedMs','micStopWrittenElapsedMs','displayExitElapsedMs'].map(key=>` const-string v0, "${key}"`).join('\n')}
.end method
`
diagnosticCode.nimo=diagnosticCode.nimo.replace('.method public final connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V', '.method public final connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V\n invoke-static {}, Landroid/os/SystemClock;->elapsedRealtime()J')

const monotonicFields=['resourceSessionStartedElapsedMs','resourceReleaseStartedElapsedMs','firmwareElapsedMs','twsElapsedMs','timeWriteStartedElapsedMs','timeAckElapsedMs','micStopStartedElapsedMs','micStopMarkerElapsedMs','micStopWrittenElapsedMs','displayExitElapsedMs']
const recorderNames={firmwareElapsedMs:'recordResourceFirmwareClock',twsElapsedMs:'recordResourceTwsClock',timeWriteStartedElapsedMs:'recordResourceTimeWriteClock',timeAckElapsedMs:'recordResourceTimeAckClock',micStopStartedElapsedMs:'recordResourceMicStopStartedClock',micStopMarkerElapsedMs:'recordResourceMicStopMarkerClock',micStopWrittenElapsedMs:'recordResourceMicStopWrittenClock',displayExitElapsedMs:'recordResourceExitClock'}
diagnosticCode.nimo += monotonicFields.map(field=>`.method private ${recorderNames[field] ?? ('record'+field)}()V
 invoke-static {}, Landroid/os/SystemClock;->elapsedRealtime()J
 move-result-wide v0
 invoke-static {v0, v1}, Ljava/lang/Long;->valueOf(J)Ljava/lang/Long;
 move-result-object v2
 iput-object v2, p0, ${desc(NIMO_DEVICE)}->${field}:Ljava/lang/Long;
.end method
`).join('')
diagnosticCode.nimo += `.method private callbackWiring()V
${Object.values(recorderNames).map(name=>` invoke-direct {p0}, ${desc(NIMO_DEVICE)}->${name}()V`).join('\n')}
.end method
`

// Match the native event entry points rather than an arbitrary surviving caller.
const sampleAssignment=field=>` invoke-static {}, Landroid/os/SystemClock;->elapsedRealtime()J
 move-result-wide v0
 invoke-static {v0, v1}, Ljava/lang/Long;->valueOf(J)Ljava/lang/Long;
 move-result-object v2
 iput-object v2, p0, ${desc(NIMO_DEVICE)}->${field}:Ljava/lang/Long;`
const callRecorder=name=>` invoke-direct {p0}, ${desc(NIMO_DEVICE)}->${name}()V`
const methodFixture=(signature,body)=>`.method private ${signature}\n${body}\n.end method\n`
const gattCallback=desc(NIMO_DEVICE).slice(0,-1)+'$gattCallback$1;'
diagnosticCode.nimo=diagnosticCode.nimo.replace('.method public final connectById(Ljava/lang/String;)V',`.method public final connectById(Ljava/lang/String;)V\n invoke-direct {p0}, ${desc(NIMO_DEVICE)}->connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V`)
diagnosticCode.nimo=diagnosticCode.nimo.replace('.method public final connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V',`.method public final connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V\n${sampleAssignment('resourceSessionStartedElapsedMs')}\n invoke-direct {p0}, ${desc(NIMO_DEVICE)}->attemptSetTime()V\n invoke-direct {p0}, ${desc(NIMO_DEVICE)}->enqueueWrite(Landroid/bluetooth/BluetoothGattCharacteristic;[B)V`)
diagnosticCode.nimo+=methodFixture('<init>()V',` new-instance v0, ${gattCallback}\n${callRecorder('recordResourceExitClock')}`)
+methodFixture('handleRxPacket([B)V',` invoke-direct {p0}, ${desc(NIMO_DEVICE)}->handleResponse(III[B)V\n invoke-direct {p0}, ${desc(NIMO_DEVICE)}->onTwsState(Z)V`)
+methodFixture('handleResponse(III[B)V',callRecorder('recordResourceFirmwareClock'))
+methodFixture('onTwsState(Z)V',callRecorder('recordResourceTwsClock'))
+methodFixture('attemptSetTime()V',callRecorder('recordResourceTimeAckClock'))
+methodFixture('enqueueWrite(Landroid/bluetooth/BluetoothGattCharacteristic;[B)V',callRecorder('recordResourceTimeWriteClock'))
+methodFixture(`releaseResource$bluetooth_sdk_nimoDiagnostic(JLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J)V`,` invoke-direct {p0}, ${desc(NIMO_DEVICE)}->releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V`)
+methodFixture('releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V',`${sampleAssignment('resourceReleaseStartedElapsedMs')}\n${callRecorder('recordResourceMicStopStartedClock')}\n${callRecorder('recordResourceMicStopWrittenClock')}`)
+methodFixture(`access$recordResourceMicStopMarkerClock(${desc(NIMO_DEVICE)})V`,callRecorder('recordResourceMicStopMarkerClock'))
diagnosticCode.nestedNimo={[gattCallback]:`.class final ${gattCallback}\n`+methodFixture('onCharacteristicChanged(Landroid/bluetooth/BluetoothGatt;Landroid/bluetooth/BluetoothGattCharacteristic;)V',` invoke-direct {p0}, ${desc(NIMO_DEVICE)}->handleRxPacket([B)V\n invoke-static {p0}, ${desc(NIMO_DEVICE)}->access$recordResourceMicStopMarkerClock(${desc(NIMO_DEVICE)})V`)}

// The command entry must call both clock overloads; dead overload invocations
// elsewhere in the diagnostics class are not admission evidence.
diagnosticCode.diagnostics=diagnosticCode.diagnostics.replace('.method public execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V',`.method public execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V
 invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->releaseCapturedResource$bluetooth_sdk_nimoDiagnostic(Lkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J)V
 invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->releaseResource$bluetooth_sdk_nimoDiagnostic(JLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J)V`)
diagnosticCode.diagnostics=diagnosticCode.diagnostics.replace(`.method public admit(${desc(NIMO_DEVICE)}Ljava/lang/String;Z)Z`,`.method public admit(${desc(NIMO_DEVICE)}Ljava/lang/String;Z)Z
 invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->resourceCaptureAdmission$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;JJ)V`)

const codeFor = name => diagnosticCode.nestedNimo[desc(name)] ?? diagnosticCode[({[NIMO_DIAGNOSTIC]:'diagnostics',[NIMO_RECEIVER]:'receiver',[NIMO_MANAGER]:'manager',[NIMO_SDK]:'sdk',[NIMO_DEVICE]:'nimo'})[name]]

const head = "a".repeat(40), base = "b".repeat(40), merge = "c".repeat(40), fingerprint = "d".repeat(64)
const ota = artifactUrl("Mentra-Community/MentraOS", "pr-builds", `ota-pr-42-${head}.json`)
const config = () => ({version: "3.3.0", android: {package: "com.mentra.mentra", versionCode: 303000123},
  extra: {unrelated: "must not appear in receipt", mentraPrBuild: {schemaVersion: 1, mobileFingerprint: fingerprint,
    mobileSourceCommit: "e".repeat(40), prHeadSha: head, buildNumber: 303000123, otaManifestUrl: ota}}})
const badging = "package: name='com.mentra.mentra' versionCode='303000123' versionName='3.3.0' platformBuildVersionName='11'"
const identity = {pr: 42, headSha: head, buildSha: merge, backend: "dev"}

test("the receipt reflects native APK metadata and preserves reused compilation identity separately", () => {
  const app = androidAppIdentity({...identity, config: config(), badging})
  assert.deepEqual(app, {packageId: "com.mentra.mentra", version: "3.3.0", build: "303000123", headSha: head,
    buildSha: merge, backend: "dev", otaManifestUrl: ota, mobileFingerprint: fingerprint, mobileSourceCommit: "e".repeat(40)})
  for (const change of [c => c.android.versionCode++, c => c.version = "3.2.0", c => c.android.package += ".other",
    c => c.extra.mentraPrBuild.prHeadSha = base, c => c.extra.mentraPrBuild.otaManifestUrl += "other"])
    { const value = config(); change(value); assert.throws(() => androidAppIdentity({...identity, config: value, badging})) }
  assert.throws(() => androidAppIdentity({...identity, backend: "prod", config: config(), badging}))
})

test("staging-targeted PRs package staging and never relabel another backend", () => {
  const staging = androidAppIdentity({...identity, backend: "staging", baseRef: "staging", config: config(), badging})
  assert.equal(staging.backend, "staging")
  for (const [backend, baseRef] of [["dev", "staging"], ["staging", "dev"], ["staging", "main"], ["staging", undefined], ["prod", "staging"]])
    assert.throws(() => androidAppIdentity({...identity, backend, baseRef, config: config(), badging}), /PR inputs/)
})

async function publishing(run, failApk = false, diagnostic = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "android-receipt-"))
  try {
    await mkdir(path.join(dir, "build-tools", "35.0.0"), {recursive: true})
    await mkdir(path.join(dir,'cmdline-tools','latest','bin'),{recursive:true})
    await mkdir(path.join(dir,'cmdline-tools','latest','lib'),{recursive:true})
    await writeFile(path.join(dir,'cmdline-tools','latest','source.properties'),'Pkg.Revision=19.0')
    await writeFile(path.join(dir,'cmdline-tools','latest','bin','apkanalyzer'),'fixed SDK launcher',{mode:0o755})
    await writeFile(path.join(dir,'cmdline-tools','latest','lib','analyzer.jar'),'fixed SDK analyzer')
    const apk = path.join(dir, "app-release.apk"); await writeFile(apk, "synthetic APK bytes")
    const calls = [], env = {GITHUB_REPOSITORY: "Mentra-Community/MentraOS", PR_NUMBER: "42", PR_HEAD_SHA: head,
      GITHUB_SHA: merge, GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "2", ANDROID_HOME: dir, EXPO_PUBLIC_BUILD_ENV: "dev", MENTRA_PR_MOBILE_FINGERPRINT: fingerprint}
    if (diagnostic) Object.assign(env, {MENTRA_NIMO_DIAGNOSTIC: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', MENTRA_PR_BUILD_SHA: merge})
    const exec = (command, args) => {
      if (command === "git") return `tree ${head}\nparent ${base}\nparent ${head}\n\nMerge PR`
      if (command === "unzip") {
        if (args.at(-1) === 'assets/nimo-resource-diagnostic.json') { if (diagnostic) return '{"schemaVersion":1,"buildType":"nimoDiagnostic","capability":"nimo-resource-v1"}'; throw new Error('not present') }
        if (args.at(-1) === 'classes*.dex') return Buffer.from(diagnostic ? 'com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE' : 'ordinary release bytecode')
        if (args.at(-1) === 'assets/index.android.bundle') return Buffer.from('bundled production JavaScript')
        return JSON.stringify(config())
      }
      if (command.endsWith("/aapt")) return badging + (diagnostic ? "\napplication-debuggable" : "")
      if(command.endsWith('/apkanalyzer')) {
        assert.deepEqual(args.slice(0,3),['dex','code','--class']);assert.equal(args.at(-1),apk)
        return codeFor(args[3])
      }
      if (command === "gh") return "10\n"
      assert.equal(command, process.execPath)
      const name = args[args.indexOf("--name") + 1]
      assert.equal(args.includes("--replace"), false)
      calls.push(name)
      if (failApk && name.endsWith(".apk")) throw new Error("APK upload failed")
      return ""
    }
    await run({apk, env, exec, calls, dir})
  } finally { await rm(dir, {recursive: true, force: true}) }
}

test("immutable signed APK publication precedes the per-attempt receipt, with no config leakage", async () => {
  await publishing(async ({apk, env, exec, calls, dir}) => {
    const receipt = await publishAndroidArtifacts(apk, env, {exec})
    const name = androidReceiptName(42, head, 100, 2)
    assert.deepEqual(calls, [name.replace(/\.json$/, ".apk"), name])
    assert.equal(receipt.baseSha, base)
    assert.equal(receipt.artifacts.android.size, 19)
    const raw = await readFile(path.join(dir, name), "utf8")
    assert.equal(raw.includes("unrelated"), false)
    for (const mutate of [r => r.runAttempt++, r => r.baseSha = "bad", r => r.app.otaManifestUrl += "other",
      r => r.artifacts.android.name = "mobile-pr-42-aaaaaaa.apk", r => r.artifacts.android.size = 0]) {
      const value = structuredClone(receipt); mutate(value)
      assert.throws(() => validateAndroidReceipt(value, {pr: 42, sha: head, runId: 100, attempt: 2}))
    }
  })
})

test("a staging receipt records its staging backend, and a mismatched build publishes nothing", async () => {
  await publishing(async ({apk, env, exec, calls}) => {
    const staging = {...env, GITHUB_BASE_REF: "staging", EXPO_PUBLIC_BUILD_ENV: "staging"}
    const receipt = await publishAndroidArtifacts(apk, staging, {exec})
    assert.equal(receipt.app.backend, "staging")
    assert.equal(validateAndroidReceipt(receipt, {pr: 42, sha: head, runId: 100, attempt: 2}), receipt.artifacts)
    for (const backend of ["prod", "", undefined]) {
      const value = structuredClone(receipt); value.app.backend = backend
      assert.throws(() => validateAndroidReceipt(value, {pr: 42, sha: head, runId: 100, attempt: 2}), /app identity/)
    }
    calls.length = 0
    await assert.rejects(publishAndroidArtifacts(apk, {...staging, EXPO_PUBLIC_BUILD_ENV: "dev"}, {exec}), /PR inputs/)
    await assert.rejects(publishAndroidArtifacts(apk, {...env, EXPO_PUBLIC_BUILD_ENV: "staging"}, {exec}), /PR inputs/)
    assert.deepEqual(calls, [])
  })
})

test("trusted dispatch publishes the pinned PR merge and backend rather than the dispatch branch", async () => {
  await publishing(async ({apk, env, exec, calls}) => {
    const source = "f".repeat(40), readCommits = []
    const dispatched = {...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: source,
      GITHUB_BASE_REF: "dev", MENTRA_PR_BUILD_SHA: merge, MENTRA_PR_BASE_REF: "staging", EXPO_PUBLIC_BUILD_ENV: "staging"}
    const checkedExec = (command, args) => {
      if (command === "git") readCommits.push(args)
      return exec(command, args)
    }
    const receipt = await publishAndroidArtifacts(apk, dispatched, {exec: checkedExec})
    assert.deepEqual(readCommits, [["cat-file", "-p", merge]])
    assert.equal(receipt.buildSha, merge)
    assert.equal(receipt.app.buildSha, merge)
    assert.equal(receipt.headSha, head)
    assert.equal(receipt.baseSha, base)
    assert.equal(receipt.app.backend, "staging")
    assert.equal(receipt.app.otaManifestUrl, ota)
    assert.equal(validateAndroidReceipt(receipt, {pr: 42, sha: head, runId: 100, attempt: 2}), receipt.artifacts)
    assert.equal(calls.length, 2)

    calls.length = 0
    for (const wrongHead of [base, source]) {
      await assert.rejects(publishAndroidArtifacts(apk, {...dispatched, PR_HEAD_SHA: wrongHead}, {exec: checkedExec}), /declared PR merge/)
    }
    await assert.rejects(publishAndroidArtifacts(apk, {...dispatched, MENTRA_PR_BUILD_SHA: "invalid"}, {exec: checkedExec}), /publication source/)
    await assert.rejects(publishAndroidArtifacts(apk, {...dispatched, MENTRA_PR_BASE_REF: "dev"}, {exec: checkedExec}), /PR inputs/)
    assert.deepEqual(calls, [])
  })
})

test("a failed APK publication never publishes a receipt", async () => {
  await publishing(async ({apk, env, exec, calls}) => {
    await assert.rejects(publishAndroidArtifacts(apk, env, {exec}), /APK upload failed/)
    assert.equal(calls.length, 1); assert.ok(calls[0].endsWith(".apk"))
  }, true)
})

test("the named PR publication step commits the receipt for the exact signed package before its alias", async () => {
  const workflow = await readFile(new URL("../workflows/mentra-app-android-build.yml", import.meta.url), "utf8")
  const producer = "node .github/scripts/pr-android-artifacts.mjs mobile/android/app/build/outputs/apk/release/app-release.apk"
  const start = workflow.indexOf(`      - name: ${ANDROID_PUBLICATION_STEP}\n        if: (github.event_name == 'pull_request' || inputs.routine_pr != '')\n`)
  const end = workflow.indexOf("\n      - name: ", start + 1)
  const step = workflow.slice(start, end)
  assert.ok(start > 0 && workflow.indexOf(producer) === workflow.lastIndexOf(producer))
  // Requesters accept an Android attempt only after this step succeeds, so a failed receipt fails the step.
  assert.ok(step.includes("set -euo pipefail\n          " + producer) && step.indexOf(producer) < step.indexOf("publish-immutable-release-asset.mjs"))
  for (const earlier of ["      - name: Package this PR's configuration and sign", "      - name: Verify release signature (not debug)"])
    assert.ok(workflow.indexOf(earlier) > 0 && workflow.indexOf(earlier) < start)
})

test('diagnostic APK publication has distinct immutable coordinates and requires actual compiled receiver, marker and bundled JavaScript', async () => {
 await publishing(async ({apk,env,exec,calls}) => {
  const receipt = await publishAndroidArtifacts(apk,env,{exec});
  assert.equal(receipt.diagnostic,'nimo-resource-v1');
  assert.equal(receipt.app.diagnostic,'nimo-resource-v1');
  assert.match(calls[0],/^mentra-android-nimo-diagnostic-pr-/);
  assert.throws(() => validateAndroidReceipt(receipt,{pr:42,sha:head,runId:100,attempt:2}),/classification/);
  validateAndroidReceipt(receipt,{pr:42,sha:head,runId:100,attempt:2,diagnostic:true});
  for (const proof of [
   {...receipt.diagnosticVerification,kind:'compiled-receiver-wiring-v1'},
   {...receipt.diagnosticVerification,captureProtocol:undefined},
   {...receipt.diagnosticVerification,captureRequiredBeforeArm:false},
   {...receipt.diagnosticVerification,kind:'compiled-capture-wiring-v2'},
   {...receipt.diagnosticVerification,clockProtocol:undefined},
   {...receipt.diagnosticVerification,clockProtocol:'epoch-v1'},
   {...receipt.diagnosticVerification,scanInstancePreserved:undefined},
   {...receipt.diagnosticVerification,scanInstancePreserved:false},
   {...receipt.diagnosticVerification,apkSha256:'e'.repeat(64)},
  ]) assert.throws(()=>validateAndroidReceipt({...receipt,diagnosticVerification:proof},{pr:42,sha:head,runId:100,attempt:2,diagnostic:true}),/verification/);

  for (const missing of ['classes*.dex','assets/nimo-resource-diagnostic.json','assets/index.android.bundle']) {
   const broken = (command,args,options) => command === 'unzip' && args.at(-1) === missing ? Buffer.alloc(0) : exec(command,args,options);
   await assert.rejects(publishAndroidArtifacts(apk,env,{exec:broken}));
  }
 },false,true);
});

test('an action literal, a stub class, or absent registration/startup wiring cannot qualify an APK', () => {
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode(diagnosticCode))
 for(const code of [
   {diagnostics:'com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE',receiver:'',manager:''},
   {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('invoke-virtual','no-op')},
   {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('new-instance','no-op')},
   {...diagnosticCode,receiver:diagnosticCode.receiver.replace('invoke-virtual','no-op')},
   {...diagnosticCode,manager:diagnosticCode.manager.replace('invoke-virtual','no-op')},
 ]) assert.throws(()=>validateNimoDiagnosticBytecode(code),/registration/)
})

test('diagnostic dispatch concurrency cannot cancel ordinary coverage and ordinary identities stay unchanged', async () => {
 const workflow=await readFile(new URL('../workflows/mentra-app-android-build.yml',import.meta.url),'utf8')
 const template=/^  group: (.+)$/m.exec(workflow)[1]
 const group=inputs=>template.replace(/\$\{\{([\s\S]*?)\}\}/g,(_,expression)=>runInNewContext(expression,{inputs,github:{workflow:'Mobile App Android Build',ref:'refs/heads/dev'},format:(text,...args)=>text.replace(/\{(\d+)\}/g,(_,n)=>args[n])}))
 const ordinary=group({routine_pr:'12',routine_base:'dev',nimo_diagnostic:false})
 assert.equal(ordinary,'android-build-Mobile App Android Build-routine-pr-12-dev')
 assert.equal(group({}), 'android-build-Mobile App Android Build-refs/heads/dev')
 assert.equal(group({routine_pr:'12',routine_base:'dev',nimo_diagnostic:true}),ordinary+'-nimo-diagnostic')
})

test('literal-only synthetic DEX cannot publish an authoritative diagnostic receipt', async () => {
 await publishing(async({apk,env,exec,calls})=>{
  const literalOnly=(command,args,options)=>command.endsWith('/apkanalyzer')?'com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE':exec(command,args,options)
  await assert.rejects(publishAndroidArtifacts(apk,env,{exec:literalOnly}),/registration/)
  assert.deepEqual(calls,[])
 },false,true)
})

async function sdkLayout(run) {
 const directory=await mkdtemp(path.join(tmpdir(),'sdk-analyzer-layout-')),sdk=path.join(directory,'sdk')
 const install=async(name,revision=name,executable=true)=>{
  const root=path.join(sdk,'cmdline-tools',name)
  await mkdir(path.join(root,'bin'),{recursive:true});await mkdir(path.join(root,'lib'),{recursive:true})
  await writeFile(path.join(root,'source.properties'),`Pkg.Revision=${revision}\n`)
  await writeFile(path.join(root,'bin','apkanalyzer'),'SDK launcher',{mode:executable?0o755:0o644})
  await writeFile(path.join(root,'lib','analyzer.jar'),'SDK analyzer implementation')
  return realpath(root)
 }
 try {await mkdir(path.join(sdk,'cmdline-tools'),{recursive:true});await run({directory,sdk,install})}
 finally {await rm(directory,{recursive:true,force:true})}
}

test('versioned-only SDK layout publishes diagnostic proof without a latest path', async()=>{
 await publishing(async({apk,env,exec,dir})=>{
  await rename(path.join(dir,'cmdline-tools','latest'),path.join(dir,'cmdline-tools','19.0'))
  const selected=await resolveAndroidSdkAnalyzer(dir)
  assert.equal(selected.analyzer,await realpath(path.join(dir,'cmdline-tools','19.0','bin','apkanalyzer')))
  assert.equal((await publishAndroidArtifacts(apk,env,{exec})).diagnosticVerification.analyzer.revision,'19.0')
 },false,true)
})

test('SDK discovery canonicalizes latest alias and hashes the actual versioned package',async()=>{
 await sdkLayout(async({sdk,install})=>{
  const actual=await install('19.0');await install('18.0')
  const exec=(_tool,args)=>codeFor(args[3])
  const before=await inspectNimoDiagnosticBytecode('/fixed/signed.apk',sdk,exec)
  await symlink(actual,path.join(sdk,'cmdline-tools','latest'),'dir')
  assert.equal((await resolveAndroidSdkAnalyzer(sdk)).root,actual)
  assert.deepEqual(await inspectNimoDiagnosticBytecode('/fixed/signed.apk',sdk,exec),before)
 })
})

test('missing, nonexecutable or unproven SDK tools never fall back to PATH or an outside alias',async()=>{
 await sdkLayout(async({directory,sdk,install})=>{
  const outside=path.join(directory,'outside');await mkdir(path.join(outside,'bin'),{recursive:true})
  await writeFile(path.join(outside,'bin','apkanalyzer'),'outside executable',{mode:0o755})
  await writeFile(path.join(outside,'source.properties'),'Pkg.Revision=99.0')
  const previous=process.env.PATH;process.env.PATH=path.join(outside,'bin')
  try {
   await assert.rejects(resolveAndroidSdkAnalyzer(sdk),/No executable/)
   await symlink(outside,path.join(sdk,'cmdline-tools','latest'),'dir')
   await assert.rejects(resolveAndroidSdkAnalyzer(sdk),/No executable/)
   const root=await install('19.0','19.0',false)
   await assert.rejects(resolveAndroidSdkAnalyzer(sdk),/No executable/)
   await chmod(path.join(root,'bin','apkanalyzer'),0o755)
   await writeFile(path.join(root,'source.properties'),'not SDK package provenance')
   await assert.rejects(resolveAndroidSdkAnalyzer(sdk),/No executable/)
  } finally {if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous}
  await assert.rejects(resolveAndroidSdkAnalyzer('caller-relative-tool'),/root must be absolute/)
 })
})

 test('old receiver-only APKs and missing capture hooks are rejected before publication', () => {
 for (const code of [
 {...diagnosticCode,sdk:undefined,nimo:undefined},
 {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('"arm-capture"','"old-command"')},
 {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('nimo-preconnect-capture-v1','old-protocol')},
 {...diagnosticCode,sdk:diagnosticCode.sdk.replaceAll('->allowManagerConnect','->unusedGuard')},
 {...diagnosticCode,sdk:diagnosticCode.sdk.replaceAll('move-result','unused-result')},
 {...diagnosticCode,nimo:diagnosticCode.nimo.replaceAll('->admit','->unusedGuard')},
 {...diagnosticCode,nimo:diagnosticCode.nimo.replaceAll('->allowPeer','->unusedGuard')},
 {...diagnosticCode,nimo:diagnosticCode.nimo.replaceAll('->beginTransport','->unusedGuard')},
 {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('->cancel','->unusedCancel')},
 ]) assert.throws(()=>validateNimoDiagnosticBytecode(code),/capture/)
 })

test('SDK fixture descriptors follow the declared Kotlin package, not its directory', async () => {
 const source=await readFile(new URL('../../mobile/modules/bluetooth-sdk/android/src/main/java/com/mentra/bluetoothsdk/types/DeviceModels.kt',import.meta.url),'utf8')
 const pkg=/^package ([A-Za-z0-9_.]+)$/m.exec(source)[1].replaceAll('.','/')
 for(const name of ['Device','ConnectOptions','DeviceModel']) assert.ok(diagnosticCode.sdk.includes(`L${pkg}/${name};`))
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,sdk:diagnosticCode.sdk.replaceAll(`${pkg}/`,`${pkg}/types/`)}),/capture/)
 // Both Kotlin internal mangling and unmangled JVM spellings are bounded and accepted.
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('releaseCapturedResource$bluetooth_sdk_nimoDiagnostic','releaseCapturedResource')}))
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('releaseCapturedResource$bluetooth_sdk_nimoDiagnostic','releaseCapturedResource$bad-module')}),/capture/)
})

test('Kotlin default bridge guards consume the exact returned boolean register', () => {
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,sdk:diagnosticCode.sdk.replaceAll('->allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z', `->allowManagerConnect$default(${desc(NIMO_DIAGNOSTIC)}Ljava/lang/String;Ljava/lang/String;ILjava/lang/Object;)Z`)}))
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,sdk:diagnosticCode.sdk.replaceAll('move-result v0\n if-eqz v0','move-result v0\n .line 35\n if-eqz v0')}))
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,sdk:diagnosticCode.sdk.replaceAll('if-eqz v0','if-eqz v1')}),/capture/)
})

test('pre-arm denial requires diagnostic build policy and every admission boundary', () => {
 for (const diagnostics of [
 diagnosticCode.diagnostics.replaceAll('"nimoDiagnostic"','"debug"'),
 diagnosticCode.diagnostics.replaceAll('->areEqual','->ignoredEqual'),
 diagnosticCode.diagnostics.replaceAll('invoke-virtual {v0}', 'invoke-virtual {v1}'),
 diagnosticCode.diagnostics.replaceAll('return v0','return v1'),
 diagnosticCode.diagnostics.replaceAll('->allowUnarmedWearable','->ignoredUnarmed'),
 diagnosticCode.diagnostics.replaceAll('->preArmCaptureRequired','->ignoredPolicy'),
 diagnosticCode.diagnostics.replaceAll('"captureRequiredBeforeArm"','"ignoredField"'),
 ]) assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics}),/policy/)
})

test('pre-arm policy inversions must reach the exact branch, return or capture field sink', () => {
 const inverted = diagnosticCode.diagnostics.replaceAll('move-result v0\n return v0', 'move-result v0\n xor-int/lit8 v3, v0, 0x1\n return v3')
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics:inverted}))
 const snapshotSink='invoke-virtual {v2, v1, v0}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;'
 const invertedSnapshot=diagnosticCode.diagnostics.replace(snapshotSink, 'xor-int/lit8 v3, v0, 0x1\n invoke-virtual {v2, v1, v3}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)Lorg/json/JSONObject;')
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics:invertedSnapshot}))
 const branch=inverted.replaceAll('return v3', 'if-eqz v3, :policy_denied\n return v4')
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics:branch}))
 for (const diagnostics of [
  inverted.replaceAll('return v3','return v0'), // inverted result discarded
  inverted.replaceAll('return v3','const/4 v3, 0x1\n return v3'), // destination overwritten
  inverted.replaceAll('xor-int/lit8 v3, v0','xor-int/lit8 v3, v1'), // unrelated input
  inverted.replaceAll('0x1','0x2'), // not boolean inversion
  branch.replaceAll('if-eqz v3','if-eqz v4'),
  invertedSnapshot.replace('"captureRequiredBeforeArm"','"unrelatedFlag"'),
  invertedSnapshot.replace('invoke-virtual {v2, v1, v3}', 'invoke-virtual {v2, v1, v0}'),
  invertedSnapshot.replace('xor-int/lit8 v3, v0, 0x1','const-string v1, "unrelatedFlag"\n xor-int/lit8 v3, v0, 0x1'),
  diagnosticCode.diagnostics.replace(snapshotSink,'return v0'), // marker is not a JSON fact
  diagnosticCode.diagnostics.replace('const-string v1, "captureRequiredBeforeArm"','const-string v1, "captureRequiredBeforeArm"\n :unproven'),
  diagnosticCode.diagnostics.replace('const-string v1, "captureRequiredBeforeArm"','const-string v1, "captureRequiredBeforeArm"\n invoke-static {}, Lother/Policy;->unproven()V'),
 ]) assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics}),/policy/)
})

test('every scan-to-connect destructive boundary consumes the Kotlin scan preservation guard', () => {
 for(const [key,signature] of [
 ['sdk','connect(Lcom/mentra/bluetoothsdk/Device;Lcom/mentra/bluetoothsdk/ConnectOptions;)V'],
 ['sdk','connectDefault(Lcom/mentra/bluetoothsdk/ConnectOptions;)V'],
 ['manager','connectByName(Ljava/lang/String;)V'],
 ]) {
  const source=diagnosticCode[key], start=source.indexOf(signature), end=source.indexOf('.end method',start)
  assert.ok(start>0 && end>start)
  const broken=source.slice(0,start)+source.slice(start,end).replace('->preserveCapturedScan(', '->ignoredPreservation(')+source.slice(end)
  assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,[key]:broken}),/capture/)
 }
})

test('clock v3 rejects epoch-only code, missing release admission and incomplete causal markers',()=>{
 for (const code of [
  {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replaceAll('nimo-monotonic-receipt-v1','old-clock')},
  {...diagnosticCode,nimo:diagnosticCode.nimo.replaceAll('Landroid/os/SystemClock;->elapsedRealtime()J','Ljava/lang/System;->currentTimeMillis()J')},
  {...diagnosticCode,nimo:diagnosticCode.nimo.replace('"releaseStartedElapsedMs"','"other"')},
  {...diagnosticCode,nimo:diagnosticCode.nimo.replace('iput-object v2, p0','iput-object v3, p0')},
  {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('resourceCaptureAdmission$','unusedCaptureAdmission$')},
  {...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace('Ljava/lang/String;J)V','Ljava/lang/String;)V')},
 ]) assert.throws(()=>validateNimoDiagnosticBytecode(code),/monotonic/)
})

test('capturing clock callbacks require instantiated nested class through exact accessor to recorder',()=>{
 const helper='recordResourceMicStopStartedClock'
 const cls=desc(NIMO_DEVICE).slice(0,-1)+'$releaseOriginalResource$1;'
 const direct=` invoke-direct {p0}, ${desc(NIMO_DEVICE)}->${helper}()V`
 const accessor=`.method public static access$${helper}(${desc(NIMO_DEVICE)})V\n${direct}\n.end method\n`
 const noCallback=diagnosticCode.nimo.replaceAll(direct,'')+accessor
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo:noCallback}),/monotonic/)
 const nestedNimo={...diagnosticCode.nestedNimo,[cls]:`.class final ${cls}\n.method public invoke()V\n invoke-static {v0}, ${desc(NIMO_DEVICE)}->access$${helper}(${desc(NIMO_DEVICE)})V\n.end method\n`}
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo:noCallback,nestedNimo}),/monotonic/)
 const nimo=noCallback.replace(/(\.method private releaseOriginalResource\([^\n]+\n)/,match=>match+` new-instance v0, ${cls}\n`)
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo,nestedNimo}))
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo,nestedNimo:{...diagnosticCode.nestedNimo,[cls]:nestedNimo[cls].replace(`->access$${helper}`,`->access$wrongRecorder`)}}),/monotonic/)
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo,nestedNimo:diagnosticCode.nestedNimo}),/callback/)
})

test('dead wiring cannot replace any original event edge or session/release sample',()=>{
 const withoutBodyCall=(code,signature,reference)=>code.replace(
  new RegExp(`(^\\.method[^\\n]* ${signature.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\n)([\\s\\S]*?)(^\\.end method)`,'m'),
  (_,header,body,end)=>header+body.replace(reference,'unused-original-event')+end)
 for(const [signature,helper] of [
  ['handleResponse(III[B)V','recordResourceFirmwareClock'],['onTwsState(Z)V','recordResourceTwsClock'],
  ['attemptSetTime()V','recordResourceTimeAckClock'],['enqueueWrite(Landroid/bluetooth/BluetoothGattCharacteristic;[B)V','recordResourceTimeWriteClock'],
  ['releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V','recordResourceMicStopStartedClock'],
  ['releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V','recordResourceMicStopWrittenClock'],
  ['<init>()V','recordResourceExitClock'],
 ]) {
  const nimo=withoutBodyCall(diagnosticCode.nimo,signature,`->${helper}()V`)
  assert.notEqual(nimo,diagnosticCode.nimo)
  assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo}),/monotonic/)
 }
 for(const [signature,field] of [
  ['connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V','resourceSessionStartedElapsedMs'],
  ['releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V','resourceReleaseStartedElapsedMs'],
 ]) {
  const nimo=withoutBodyCall(diagnosticCode.nimo,signature,`->${field}:Ljava/lang/Long;`)
  assert.notEqual(nimo,diagnosticCode.nimo)
  assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo}),/monotonic/)
 }
 const nimo=diagnosticCode.nimo.replace(` new-instance v0, ${gattCallback}`,'')+methodFixture('deadCallbackFactory()V',` new-instance v0, ${gattCallback}`)
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo}),/monotonic/)
})

test('dead same-name release overload cannot replace the exact reached release sample',()=>{
 const signature='releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V'
 const expression=new RegExp(`(^\\.method[^\\n]* ${signature.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\n)([\\s\\S]*?)(^\\.end method)`,'m')
 const missing=diagnosticCode.nimo.replace(expression,(_,header,body,end)=>header+body.replace('->resourceReleaseStartedElapsedMs:Ljava/lang/Long;','->unusedReleaseClock:Ljava/lang/Long;')+end)
 assert.notEqual(missing,diagnosticCode.nimo)
 const nimo=missing+methodFixture('releaseOriginalResource()V',sampleAssignment('resourceReleaseStartedElapsedMs'))
 assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,nimo}),/monotonic/)
})

test('clock command overloads and admission must be called by their live entry methods',()=>{
 const change=(signature,reference)=>diagnosticCode.diagnostics.replace(
  new RegExp(`(^\\.method[^\\n]* ${signature.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\n)([\\s\\S]*?)(^\\.end method)`,'m'),
  (_,header,body,end)=>header+body.replace(reference,'unusedClockOverload')+end)
 for(const [signature,reference] of [
  ['execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V','->releaseCapturedResource$bluetooth_sdk_nimoDiagnostic(Lkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J)V'],
  ['execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V','->releaseResource$bluetooth_sdk_nimoDiagnostic(JLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J)V'],
  [`admit(${desc(NIMO_DEVICE)}Ljava/lang/String;Z)Z`,'->resourceCaptureAdmission$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;JJ)V'],
 ]) {
  const diagnostics=change(signature,reference)
  assert.notEqual(diagnostics,diagnosticCode.diagnostics)
  assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics}),/monotonic/)
 }
})

test('pinned Kotlin2.3/AGP8.12 policy output preserves boolean consumption without adjacency assumptions', async () => {
 const actual=await readFile(new URL('./fixtures/nimo-policy-kotlin23/diagnostics.smali',import.meta.url),'utf8')
 const body=(text,signature)=>text.match(new RegExp(`^\\.method[^\\n]* ${signature.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\n([\\s\\S]*?)^\\.end method`,'m'))?.[1]
 const replaceBody=(text,signature,value)=>{
  const old=body(text,signature); assert.ok(old,signature); return text.replace(old,value)
 }
 let diagnostics=diagnosticCode.diagnostics
 for(const signature of [`${policy}(Ljava/lang/String;)Z`,policyDefault,'allowUnarmedWearable$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;Ljava/lang/String;)Z','allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z']) {
  const emitted=body(actual,signature);assert.ok(emitted,signature);diagnostics=replaceBody(diagnostics,signature,emitted)
 }
 // Actual simplified admit wrapper uses the same !default-policy expression as
 // the full source's capture-null path. It is not a full APK fixture.
 for(const name of ['admit','allowPeer','beginTransport']) diagnostics=replaceBody(diagnostics,`${name}(${desc(NIMO_DEVICE)}Ljava/lang/String;Z)Z`,(name==='admit' ? ` invoke-virtual {v0}, ${desc(NIMO_DEVICE)}->resourceCaptureAdmission$bluetooth_sdk_nimoDiagnostic(Ljava/lang/String;JJ)V\n` : '')+body(actual,'admit()Z'))
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics}))
 const admitSignature=`admit(${desc(NIMO_DEVICE)}Ljava/lang/String;Z)Z`
 const admitted=body(diagnostics,admitSignature)
 for(const [label,changed] of [
  ['self xor preloaded one',admitted.replace('const/4 v1, 0x1','const/4 v0, 0x1').replace('xor-int/2addr v0, v1','xor-int/2addr v0, v0')],
  ['zero',admitted.replace('v1, 0x1','v1, 0x0')],
  ['two',admitted.replace('v1, 0x1','v1, 0x2')],
  ['unknown',admitted.replace('const/4 v1, 0x1','move v1, p1')],
  ['clobbered one',admitted.replace('xor-int/2addr','const/4 v1, 0x0\n xor-int/2addr')],
  ['clobbered result',admitted.replace('xor-int/2addr','const/4 v0, 0x1\n xor-int/2addr')],
  ['wrong xor destination',admitted.replace('xor-int/2addr v0','xor-int/2addr v2')],
  ['wrong sink',admitted.replace('return v0','return v1')],
  ['label',admitted.replace('xor-int/2addr',':unproven\n xor-int/2addr')],
  ['goto',admitted.replace('xor-int/2addr','goto :unproven\n xor-int/2addr')],
  ['borrowed across label',admitted.replace('invoke-static',':unproven\n invoke-static')],
  ['unknown call',admitted.replace('xor-int/2addr','invoke-static {}, Lother/Policy;->unproven()V\n xor-int/2addr')],
 ]) assert.throws(()=>validateNimoDiagnosticBytecode({...diagnosticCode,diagnostics:replaceBody(diagnostics,admitSignature,changed)}),/policy wiring: admit/,label)
})

test('exact capture snapshot expression consumes its post-call literal JSON key',async()=>{
 const emitted=await readFile(new URL('./fixtures/nimo-policy-kotlin23/snapshot.smali',import.meta.url),'utf8')
 const actual=emitted.match(/^\.method[^\n]* captureSnapshot\([^\n]*\n([\s\S]*?)^\.end method/m)[1]
 const original=diagnosticCode.diagnostics.match(/^\.method[^\n]* captureSnapshot\([^\n]*\n([\s\S]*?)^\.end method/m)[1]
 const replace=body=>({...diagnosticCode,diagnostics:diagnosticCode.diagnostics.replace(original,body)})
 assert.doesNotThrow(()=>validateNimoDiagnosticBytecode(replace(actual)))
 for(const changed of [
  actual.replace('const-string v2, "captureRequiredBeforeArm"','const-string v1, "captureRequiredBeforeArm"'),
  actual.replace('const-string v2, "captureRequiredBeforeArm"','const-string v2, "captureRequiredBeforeArm"\n const-string v2, "wrong"'),
  actual.replace('const-string v2, "captureRequiredBeforeArm"','const-string v2, "captureRequiredBeforeArm"\n const/4 v2, 0x1'),
  actual.replace('invoke-virtual {v0, v2, v1}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)','invoke-virtual {v0, v2, v3}, Lorg/json/JSONObject;->put(Ljava/lang/String;Z)'),
  actual.replace('const-string v2, "captureRequiredBeforeArm"',':unproven\n const-string v2, "captureRequiredBeforeArm"'),
  actual.replace('const-string v2, "captureRequiredBeforeArm"','const-string v2, "1"\n xor-int/2addr v1, v2\n const-string v2, "captureRequiredBeforeArm"'),
 ]) assert.throws(()=>validateNimoDiagnosticBytecode(replace(changed)),/policy wiring: captureRequiredBeforeArm JSON field/)
})
