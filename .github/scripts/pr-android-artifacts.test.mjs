import assert from "node:assert/strict"
import test from "node:test"
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {ANDROID_PUBLICATION_STEP, androidAppIdentity, androidReceiptName, publishAndroidArtifacts, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {validateNimoDiagnosticBytecode, NIMO_DIAGNOSTIC, NIMO_RECEIVER, NIMO_MANAGER} from "./pr-android-artifacts-diagnostic.mjs"
import {runInNewContext} from "node:vm"
import {artifactUrl} from "./release-artifact-storage.mjs"


const desc = name => `L${name.replaceAll('.', '/')};`
const diagnosticCode = {
 diagnostics:`.class public final ${desc(NIMO_DIAGNOSTIC)}
.method public final start(Landroid/content/Context;)V
 const-string v0, "com.mentra.bluetoothsdk.NIMO_RESOURCE_LIFECYCLE"
 const-string v1, "android.permission.DUMP"
 sget-object v2, ${desc(NIMO_DIAGNOSTIC)}->receiver:${desc(NIMO_RECEIVER)}
 invoke-virtual {v0, v2}, Landroid/content/Context;->registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;)Landroid/content/Intent;
.end method
.method static constructor <clinit>()V
 new-instance v0, ${desc(NIMO_RECEIVER)}
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
    await writeFile(path.join(dir,'cmdline-tools','latest','bin','apkanalyzer'),'fixed SDK launcher')
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
        return args[3] === NIMO_DIAGNOSTIC ? diagnosticCode.diagnostics : args[3] === NIMO_RECEIVER ? diagnosticCode.receiver : diagnosticCode.manager
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
