import {afterEach, expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {createMtkFullRestoreRuntime} from "./mtk-full-restore-runtime"
import type {MtkFullRestoreInputs} from "./mtk-full-restore"
import type {LifecycleContext, MutationIntent} from "./lifecycle"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, {recursive: true, force: true})))
})
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const oldBoot = "00000000-1111-2222-3333-444444444444",
  newBoot = "11111111-1111-2222-3333-444444444444"
const probe = "c0488244fe62e24f0ca2c855355de01bc687d1d8ae762336e2fc0405e5e42a8e"
async function harness() {
  const folder = await mkdtemp(join(tmpdir(), "mtk-runtime-"))
  dirs.push(folder)
  const python = await realpath(new TextDecoder().decode(Bun.spawnSync(["which", "python3"]).stdout).trim())
  const statePath = join(folder, "state.json")
  const state = {
    firmware: "MentraLive_20260921.0",
    target: "MentraLive_20260921.0",
    boot: oldBoot,
    slot: "_a",
    asg: 303006291,
    bes: "26.9.21.3",
    uptime: 100,
    engine: "UPDATE_STATUS_IDLE",
    busy: false,
    generation: 0,
    mac: "AA:BB:CC:DD:EE:01",
    logs: [],
    commands: [],
    remote: false,
    applies: 0,
    reboots: 0,
  }
  const set = async (value: unknown) => writeFile(statePath, JSON.stringify(value), {mode: 0o600})
  await set(state)
  const adb = join(folder, "adb")
  await writeFile(
    adb,
    `#!${python}
import sys,json,re,hashlib
p=${JSON.stringify(statePath)}
s=json.load(open(p));a=sys.argv[1:];s['commands'].append(a);s['uptime']=round(s['uptime']+0.005,3)
def done(out='',code=0):
 json.dump(s,open(p,'w'));print(out);sys.exit(code)
def ble(v):
 s['logs'].append(f"{s['uptime']:.6f} 1335 1500 I MentraBleTrace: BLE_TRACE direction=glasses_to_phone layer=asg_ble_output source=asg_client type={v['type']} bytes=500 payload="+json.dumps(v))
if a==['devices','-l']:done('List of devices attached\\nTEST012345 device usb:1-2 transport_id:7')
if a==['-t','7','reboot']:
 s.update(boot=${JSON.stringify(newBoot)},slot='_b',firmware=s['target'],engine='UPDATE_STATUS_IDLE');s['reboots']+=1;done()
if a[:3]==['-t','7','push']:s['remote']=True;done('1 file pushed')
if a[:3]!=['-t','7','shell']:done('bad transport',7)
c=' '.join(a[3:]);remote='/data/local/tmp/mentra-update-engine-status-${probe}.jar'
values={'cat /sys/block/mmcblk0/device/cid':'0123456789abcdef0123456789abcdef','getprop ro.serialno':'TEST012345','getprop ro.boot.serialno':'TEST012345','getprop persist.mentra.live.mac':s['mac'],'getprop ro.custom.ota.version':s['firmware'],'getprop sys.boot_completed':'1','cat /proc/sys/kernel/random/boot_id':s['boot'],'getprop ro.boot.slot_suffix':s['slot'],'dumpsys package com.mentra.asg_client':'versionCode='+str(s['asg']),'pidof com.mentra.asg_client':'1335','cat /proc/1335/stat':'1335 (asg) S '+' '.join(['0']*18)+' 2485 0','getconf CLK_TCK':'100','cat /proc/uptime':str(s['uptime'])+' 0','test ! -L '+remote:'','sha256sum '+remote:'${probe} '+remote,'stat -c %s '+remote:'2143','pm path com.mentra.asg_client':'package:/data/app/owned/base.apk','sha256sum /data/app/owned/base.apk':s.get('apkSha','${"d".repeat(64)}')+' /data/app/owned/base.apk','df -k /data':'Filesystem 1K-blocks Used Available Use% Mounted on\\n/dev/data 9000000 1 8000000 1% /data'}
if c in values:done(values[c])
if c.startswith('CLASSPATH='):done('CURRENT_OP='+s['engine']+'\\nSTATUS_CODE='+('0' if s['engine']=='UPDATE_STATUS_IDLE' else '6'),7 if s.get('failStatus') else 0)
if c=='logcat -b main -d -v threadtime -v monotonic -v usec':done(f"{s['uptime']-0.1:.6f} 1335 1500 I K900BluetoothManager: BES_OTA_DIAG version_proof actual={s['bes']} current_boot={s.get('besProofBoot',s['boot'])} owner=fixture\\n"+'\\n'.join(s['logs']))
if c.startswith("test ! -e '/storage/"):done('',1 if s['remote'] else 0)
if c.startswith("stat -c %s '/storage/"):done(str(s['artifactSize'])+'\\n'+s['artifactSha']+' remote')
m=re.search(r"--es json '(.*)'$",c)
if m and c.startswith('am broadcast -n com.mentra.asg_client/.receiver.IntentCommandReceiver '):
 q=json.loads(m[1]);sid='0123abcd'
 if q['type']=='request_version':ble({'type':'version_info_1','package_name':'com.mentra.asg_client','build_number':str(s['asg']),'sid':sid,'request_id':q['request_id']})
 elif q['type']=='get_stream_status':ble({'type':'stream_status','kind':'snapshot','sid':sid,'revision':0,'status':'stopped','terminal':True,'streaming':False,'reconnecting':False})
 elif q['type']=='ota_query_status':
  v={'schema':1,'request_id':q['request_id'],'process_sid':sid,'elapsed_realtime_ms':round(s['uptime']*1000),'admission_generation':s['generation'],'admission_held':False,'updating':False,'mtk_in_progress':False,'bes_in_progress':s['busy'],'consistent':True,'session':{'session_id':'','status':'idle','restart_pending':False}}
  s['logs'].append(f"{s['uptime']:.6f} 1335 1500 I OtaCommandHandler: OTA activity snapshot: "+json.dumps(v))
 else:done('bad query',7)
 done('Broadcast completed: result=0')
done('unexpected '+c,7)
`,
    {mode: 0o700},
  )
  await chmod(adb, 0o700)
  const bridge = join(folder, "bridge.py")
  await writeFile(
    bridge,
    `import sys,json,os,time,pathlib
r=json.load(open(sys.argv[sys.argv.index('--request')+1]));out=pathlib.Path(r['auditDirectory']);out.mkdir(mode=0o700)
def save(path,v):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(v,f);f.flush();os.fsync(f.fileno())
if r['mode']=='power':
 now=time.time();save(out/'result.json',{'status':'passed','mac':r['fixture']['bluetooth'],'firmwareWrites':0,'mtkReady':True,'queryCount':1,'sentAt':now,'observedAt':now,'identityRecheckedAt':now,'batteryPercent':90,'voltageMillivolts':4000,'charging':True});print(json.dumps({'type':'finished'}));sys.exit(0)
original=json.load(open(r['sourceIntent']['path']));owner=original['operationID'];source=original['source'];argv=r['argv'];remote=original['remote']
save(out/'invocation.json',{'owner':owner,'sourceIntent':r['sourceIntent'],'argv':argv})
b=['adb','-t',source['transport'],'shell','am','broadcast','-a','com.xy.updateota','-p','com.android.systemui','--es','cmd','start','--es','pkname','com.mentra.asg_client','--es','path',remote]
print(json.dumps({'type':'before-apply','owner':owner,'argv':b}),flush=True)
approval=sys.stdin.readline()
if not approval:sys.exit(9)
assert json.loads(approval)=={'owner':owner,'approved':True}
save(out/'apply-approved.json',{'owner':owner,'sourceIntent':r['sourceIntent'],'argv':b})
target=pathlib.Path(argv[argv.index('--output')+1]);target.mkdir(mode=0o700)
identity={'version':source['firmware'],'slot':source['slot'],'serial':source['serial'],'emmc_cid':source['cid'],'boot_id':source['bootId'],'transport':source['transport'],'usb_path':source.get('usb'),'wifi_endpoint':source.get('wifiEndpoint')}
save(target/'preflight.json',{**identity,'ota_sha256':original['target']['sha256'],'ota_size':original['target']['size'],'update_engine':{'current_op':'UPDATE_STATUS_IDLE'}})
marker='100.25 MentraMtkStage mentra-mtk-stage-'+owner.replace('-','')
save(target/'broadcast.json',{'returncode':0,'stdout':'Broadcast completed: result=0','log_boundary':marker})
save(target/'result.json',{'success':True,'ota_sha256':original['target']['sha256'],'source_version':source['firmware'],'source_slot':source['slot'],'post_identity':identity,'post_update_engine':{'current_op':'UPDATE_STATUS_UPDATED_NEED_REBOOT'},'log_boundary':marker})
s=json.load(open(${JSON.stringify(statePath)}));s['engine']='UPDATE_STATUS_UPDATED_NEED_REBOOT';s['applies']+=1;json.dump(s,open(${JSON.stringify(statePath)},'w'))
print(json.dumps({'type':'finished','owner':owner}),flush=True)
`,
    {mode: 0o600},
  )
  const pin = async (path: string) => ({path, sha256: hash(await readFile(path))})
  const artifact = join(folder, "full.zip")
  await writeFile(artifact, "simulated private payload")
  const ref = await pin(artifact),
    size = (await readFile(artifact)).length
  const component = {url: "https://example.test/frozen", sha256: "d".repeat(64), size: 10}
  const input: MtkFullRestoreInputs = {
    fixture: {cid: "0123456789abcdef0123456789abcdef", bluetooth: state.mac, serials: ["TEST012345"], usb: "1-2"},
    profile: {
      manifest: component,
      mtk: {version: state.target, artifact: {...component, sha256: ref.sha256, size}},
      asg: {versionCode: 303006291, artifact: component},
      bes: {version: "26.9.21.3", artifact: component},
    },
    artifact: {...ref, size},
    python,
    helper: ref,
    probe: {path: artifact, sha256: probe, remote: `/data/local/tmp/mentra-update-engine-status-${probe}.jar`},
  }
  const leasePath = join(folder, "lease.json")
  await writeFile(leasePath, JSON.stringify({pid: process.pid, token: "fixture-test"}), {mode: 0o600})
  const config = {
    leasePath,
    adb: await pin(adb),
    pythonSha256: (await pin(python)).sha256,
    bridge: await pin(bridge),
    january: {directory: folder, definition: {}},
    sourceProfiles: [{...input.profile, mtk: {...input.profile.mtk, version: "MentraLive_20260920.0"}}],
  }
  const runDirectory = join(folder, "run")
  await mkdir(runDirectory, {mode: 0o700})
  const c: LifecycleContext = {
    runDirectory,
    selection: {
      runID: "runtime-test",
      fixtureID: input.fixture.cid,
      returnProfileDigest: input.profile.manifest.sha256,
      inputs: {},
    },
    operations: [],
  }
  await set({...state, artifactSha: ref.sha256, artifactSize: size})
  const get = async () => JSON.parse(await readFile(statePath, "utf8"))
  const runtime = createMtkFullRestoreRuntime(input, config)
  return {folder, input, config, c, runtime, get, set}
}

test("actual fake subprocess reads qualify current-target idle without power, transfer or lease changes", async () => {
  const h = await harness(),
    value = await h.runtime.read(h.c)
  expect(value).toMatchObject({
    writersIdle: true,
    engineStatus: "UPDATE_STATUS_IDLE",
    powerReady: false,
    identity: {bootId: oldBoot, firmware: h.input.profile.mtk.version},
  })
  const state = await h.get()
  expect(state.applies).toBe(0)
  expect(state.reboots).toBe(0)
  expect(
    state.commands.some((a: string[]) => a.includes("connect") || a.includes("push") || a.includes("reboot")),
  ).toBe(false)
  const lease = JSON.parse(await readFile(h.config.leasePath, "utf8"))
  expect(lease.pid).toBe(process.pid)
}, 15000)

test("legacy, wrong MAC, changed active APK and nonzero reads cannot prove modern idle", async () => {
  for (const change of [{asg: 37}, {mac: ""}, {busy: true}, {apkSha: "e".repeat(64)}, {failStatus: true}]) {
    const h = await harness()
    await h.set({...(await h.get()), ...change})
    if ("busy" in change) expect((await h.runtime.read(h.c)).writersIdle).toBe(false)
    else await expect(h.runtime.read(h.c)).rejects.toThrow()
    expect((await h.get()).applies).toBe(0)
  }
}, 30000)

test("explicit January BES with selected or January MTK can be idle without satisfying target assertions", async () => {
  for (const firmware of ["MentraLive_20260921.0", "MentraLive_20260113"]) {
    const h = await harness()
    await h.set({...(await h.get()), firmware, bes: "17.26.1.13"})
    const setupBaseline = {mtkVersion: "MentraLive_20260113", besVersion: "17.26.1.13"}
    const runtime = createMtkFullRestoreRuntime(h.input, {...h.config, setupBaseline})
    const value = await runtime.read(h.c)
    expect(value).toMatchObject({writersIdle: true, engineStatus: "UPDATE_STATUS_IDLE", identity: {firmware}})
    const actual = value.actual as any
    expect(actual.sourceProfile).toEqual(h.input.profile)
    expect(actual.selectedTargetProfile).toEqual(h.input.profile)
    expect(actual.setupBaseline).toEqual(setupBaseline)
    expect(actual.observation.bes.version).toBe("17.26.1.13")
    expect(actual.allowedSource.mtkVersions).toContain("MentraLive_20260113")
    const collector = JSON.parse(await readFile(value.evidence[0]!, "utf8"))
    const assertion = (id: string) => collector.firmwareAssertions.find((item: any) => item.id === id)
    expect(assertion("firmware.mtk").status).toBe(firmware === h.input.profile.mtk.version ? "passed" : "failed")
    expect(assertion("firmware.bes.version").status).toBe("failed")
    expect(assertion("firmware.bes.fresh").status).toBe("passed")
    expect(collector.adbQualified).toBe(false)
    expect(collector.returnObservationPassed).toBe(false)
    expect((await h.get()).applies).toBe(0)
    expect((await h.get()).reboots).toBe(0)
  }
}, 30000)

test("mixed-source permission never admits unknown firmware, BES, legacy ASG or conflicting modern APK", async () => {
  for (const change of [{firmware: "MentraLive_20250101"}, {bes: "17.26.1.12"}, {asg: 27}, {apkSha: "e".repeat(64)}]) {
    const h = await harness()
    await h.set({...(await h.get()), ...change})
    const runtime = createMtkFullRestoreRuntime(h.input, {
      ...h.config,
      setupBaseline: {mtkVersion: "MentraLive_20260113", besVersion: "17.26.1.13"},
    })
    await expect(runtime.read(h.c)).rejects.toThrow()
    expect((await h.get()).applies).toBe(0)
    expect((await h.get()).reboots).toBe(0)
  }
}, 30000)

test("ASG profile matching ignores MTK/BES combinations but rejects ambiguous ASG bytes", async () => {
  const h = await harness()
  const sameApk = {
    ...h.input.profile,
    manifest: {...h.input.profile.manifest, url: "https://example.test/another-manifest"},
    mtk: {...h.input.profile.mtk, version: "MentraLive_20260920.0"},
    bes: {...h.input.profile.bes, version: "17.26.1.13"},
    asg: {
      ...h.input.profile.asg,
      artifact: {...h.input.profile.asg.artifact, url: "https://example.test/identical-apk"},
    },
  }
  await h.set({...(await h.get()), bes: "17.26.1.13"})
  expect(
    (await createMtkFullRestoreRuntime(h.input, {...h.config, sourceProfiles: [sameApk]}).read(h.c)).writersIdle,
  ).toBe(true)
  const changedApk = {...sameApk, asg: {...sameApk.asg, artifact: {...sameApk.asg.artifact, sha256: "e".repeat(64)}}}
  await expect(
    createMtkFullRestoreRuntime(h.input, {...h.config, sourceProfiles: [changedApk]}).read(h.c),
  ).rejects.toThrow("Ambiguous")
}, 20000)

test("an already-target stage without a transfer claim does not freeze later component admission", async () => {
  const h = await harness()
  const owner: MutationIntent = {
    operationID: "abcdefab-1111-2222-3333-444444444444",
    stepID: "restore-mtk-stage",
    phase: "teardown",
    startedAt: new Date().toISOString(),
  }
  h.c.operations = [owner]
  await h.set({...(await h.get()), generation: 7})
  expect((await h.runtime.read(h.c)).writersIdle).toBe(true)
  // Only a real transfer creates this file and protects the same-boot interval.
  const first = await h.runtime.read(h.c)
  await writeFile(
    join(h.c.runDirectory, `mtk-full-${owner.operationID}.transfer.json`),
    JSON.stringify({source: first.identity, writerIdentity: (first.actual as any).writerIdentity}),
    {mode: 0o600},
  )
  await h.set({...(await h.get()), generation: 8})
  expect((await h.runtime.read(h.c)).writersIdle).toBe(false)
}, 30000)

test("concrete transfer/helper gate persist original receipts and recovery reads without subprocess or resend", async () => {
  const h = await harness()
  await h.set({...(await h.get()), firmware: "MentraLive_20260920.0"})
  const source = (await h.runtime.read(h.c)).identity
  const intent: MutationIntent = {
    operationID: "abcdefab-1111-2222-3333-444444444444",
    phase: "teardown",
    stepID: "restore-mtk-stage",
    startedAt: new Date().toISOString(),
  }
  h.c.operations = [intent]
  const output = join(h.c.runDirectory, `mtk-full-${intent.operationID}`),
    remote = `/storage/emulated/0/asg/mentra-restore-${intent.operationID}.zip`
  const sourcePath = output + ".intent.json"
  await writeFile(
    sourcePath,
    JSON.stringify({
      kind: "mtk-full-source/v1",
      operationID: intent.operationID,
      startedAt: intent.startedAt,
      runDirectory: h.c.runDirectory,
      inputDigest: hash(Buffer.from(JSON.stringify(h.input))),
      source,
      remote,
      target: {
        manifest: h.input.profile.manifest.sha256,
        version: h.input.profile.mtk.version,
        sha256: h.input.artifact.sha256,
        size: h.input.artifact.size,
      },
    }),
    {mode: 0o600},
  )
  const sourceIntent = {path: sourcePath, sha256: hash(await readFile(sourcePath))}
  const bound = {context: h.c, intent, source, remote, sourceIntent}
  const gate = async () => {
    expect((await h.runtime.read(h.c)).writersIdle).toBe(true)
  }
  await h.runtime.transfer({...bound, local: h.input.artifact.path, beforeWrite: gate})
  const argv = [h.input.python, h.input.helper.path, "--output", output]
  const result = await h.runtime.stage({...bound, argv, probe: h.input.probe, beforeApply: gate})
  expect(result.exitCode).toBe(0)
  expect((await h.get()).applies).toBe(1)
  // Simulate the crash boundary: original helper files survived, outer exit/journal did not.
  await rm(output + ".runtime/process/command.json")
  const before = (await h.get()).commands.length
  const recovered = await createMtkFullRestoreRuntime(h.input, h.config).readStageEvidence({
    ...bound,
    argv,
    outputDirectory: output,
  })
  expect(recovered?.exitCode).toBeNull()
  expect(recovered?.receipt).toMatchObject({success: true})
  expect((await h.get()).commands.length).toBe(before)
  await expect(h.runtime.transfer({...bound, local: h.input.artifact.path, beforeWrite: gate})).rejects.toThrow()
  expect((await h.get()).applies).toBe(1)
  const activation: MutationIntent = {
    operationID: "abcdefab-5555-2222-3333-444444444444",
    stepID: "restore-mtk-activate",
    phase: "teardown",
    startedAt: new Date().toISOString(),
  }
  h.c.operations = [intent, activation]
  await h.runtime.reboot({...bound, intent: activation, argv: ["adb", "-t", "7", "reboot"], beforeReboot: gate})
  expect((await h.get()).reboots).toBe(1)
  await expect(
    h.runtime.reboot({...bound, intent: activation, argv: ["adb", "-t", "7", "reboot"], beforeReboot: gate}),
  ).rejects.toThrow()
  expect((await h.get()).reboots).toBe(1)
  // This crosses transfer, apply, crash recovery and reboot through real fake
  // subprocesses and fsynced receipts. Linux CI needs more than the Mac's 26s.
}, 90000)

test("missing verification record fails before payload transfer, and foreign receipt cannot be adopted", async () => {
  const h = await harness()
  await expect(h.runtime.verifyArtifact(h.input, h.c)).rejects.toThrow("pinned offline verification record")
  expect((await h.get()).commands).toEqual([])
  await writeFile(h.config.leasePath, JSON.stringify({pid: 1, token: "foreign"}), {mode: 0o600})
  await expect(h.runtime.read(h.c)).rejects.toThrow("fixture lease")
}, 15000)
