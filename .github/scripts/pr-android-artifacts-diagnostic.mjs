import {createHash} from 'node:crypto'
import {readFile, readdir, realpath, access, stat} from 'node:fs/promises'
import {constants} from 'node:fs'
import path from 'node:path'
// Android SDK apkanalyzer disassembles the actual signed artifact, never source or caller metadata.
export const NIMO_DIAGNOSTIC = 'com.mentra.bluetoothsdk.sgcs.NimoResourceDiagnostics'
export const NIMO_RECEIVER = `${NIMO_DIAGNOSTIC}$receiver$1`
export const NIMO_MANAGER = 'com.mentra.bluetoothsdk.DeviceManager'
export const NIMO_SDK = 'com.mentra.bluetoothsdk.MentraBluetoothSdk'
export const NIMO_DEVICE = 'com.mentra.bluetoothsdk.sgcs.Nimo'
export const CLOCK_PROTOCOL = 'nimo-monotonic-receipt-v1'
export const CAPTURE_PROTOCOL = 'nimo-preconnect-capture-v1'
const descriptor = name => `L${name.replaceAll('.', '/')};`
const escaped = value => [...value].map(char => '\\^$.*+?()[]{}|'.includes(char) ? '\\' + char : char).join('')
function method(code, signature) {
  const methods = [...code.matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)]
  return methods.find(value => value[1].trim().endsWith(signature))?.[2] ?? ''
}
export function validateNimoDiagnosticBytecode({diagnostics, receiver, manager, sdk, nimo, nestedNimo = {}}) {
  const target = descriptor(NIMO_DIAGNOSTIC), child = descriptor(NIMO_RECEIVER), owner = descriptor(NIMO_MANAGER)
  const hasClass = (text, name) => new RegExp(`^\\.class[^\\n]* ${escaped(name)}$`, 'm').test(text)
  const invoke = (text, reference) => new RegExp(`^\\s*invoke-[^\\n]+${reference}`, 'm').test(text)
  const start = method(diagnostics, 'start(Landroid/content/Context;)V')
  const receive = method(receiver, 'onReceive(Landroid/content/Context;Landroid/content/Intent;)V')
  if (!hasClass(diagnostics, target) || !hasClass(receiver, child) || !hasClass(manager, owner) ||
      !/^\.super Landroid\/content\/BroadcastReceiver;$/m.test(receiver) ||
      !/const-string(?:\/jumbo)?[^\n]*"com\.mentra\.bluetoothsdk\.NIMO_RESOURCE_LIFECYCLE"/.test(start) ||
      !/const-string(?:\/jumbo)?[^\n]*"android\.permission\.DUMP"/.test(start) ||
      !start.includes(`${target}->receiver:`) ||
      !/const-string(?:\/jumbo)?[^\n]*"com\.mentra\.bluetoothsdk\.NIMO_RESOURCE_LIFECYCLE"/.test(receive) ||
      !invoke(start, 'Landroid/content/IntentFilter;-><init>\\(Ljava/lang/String;\\)V') ||
      !invoke(start, 'Landroid/content/Context;->registerReceiver\\(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;(?:I)?\\)Landroid/content/Intent;') ||
      !new RegExp(`new-instance[^\\n]*${escaped(child)}`).test(method(diagnostics, '<clinit>()V')) ||
      !invoke(method(diagnostics, '<clinit>()V'), `${escaped(child)}-><init>\\(`) ||
      !invoke(receive, `${escaped(target)}->execute(?:\\$[A-Za-z0-9_]+)?\\(Landroid/content/Intent;\\)V`) ||
      !invoke(manager, `${escaped(target)}->start\\(Landroid/content/Context;\\)V`))
    throw new Error('Diagnostic APK lacks compiled NIMO receiver class and registration/startup wiring')

  // The v3 boundary requires the compiled phone clock producer and every causal
  // marker, not a receipt claiming that an old epoch-only APK understands it.
  const elapsed = 'Landroid/os/SystemClock;->elapsedRealtime\\(\\)J'
  const nativeSnapshot = [...(nimo ?? '').matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)].find(v=>/resourceSnapshot(?:\$[A-Za-z0-9_]+)?\(\)Lorg\/json\/JSONObject;$/.test(v[1].trim()))?.[2] ?? ''
  const clockFields = ['observedElapsedMs','captureNonce','armedElapsedMs','admittedElapsedMs','sessionStartedElapsedMs','releaseNonce','releaseStartedElapsedMs',
    'firmwareElapsedMs','twsElapsedMs','handshakeTwsElapsedMs','timeWriteStartedElapsedMs','timeAckElapsedMs','micStopStartedElapsedMs','micStopMarkerElapsedMs','micStopWrittenElapsedMs','displayExitElapsedMs']
  const definitions = code => [...code.matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)]
  const nestedReferences = code => [...code.matchAll(/^\s*new-instance[^\n]* (Lcom\/mentra\/bluetoothsdk\/sgcs\/Nimo\$[A-Za-z0-9_$]+;)/gm)].map(match=>match[1])
  const reachableNested = new Set(), pendingNested = nestedReferences(nimo ?? '')
  while (pendingNested.length) {
    const cls=pendingNested.shift()
    if (reachableNested.has(cls)) continue
    if (reachableNested.size >= 128 || !hasClass(nestedNimo[cls] ?? '',cls))
      throw new Error('Diagnostic APK lacks bounded compiled capture callback class evidence')
    reachableNested.add(cls)
    pendingNested.push(...nestedReferences(nestedNimo[cls]))
  }
  const fixedExecute=definitions(diagnostics).find(([,header])=>/ execute(?:\$[A-Za-z0-9_]+)?\(Landroid\/content\/Intent;\)V$/.test(header.trim()))?.[2] ?? ''
  const captureAdmission=method(diagnostics,`admit(${descriptor(NIMO_DEVICE)}Ljava/lang/String;Z)Z`)
  const native = descriptor(NIMO_DEVICE)
  const nodes=new Map()
  for(const [cls,code] of [[native,nimo ?? ''],...Object.entries(nestedNimo)])
    for(const [,header,body] of definitions(code)) {
      const signature=header.trim().split(/\s+/).at(-1)
      nodes.set(`${cls}->${signature}`,{cls,signature,body})
    }
  const matching=(cls,expression)=>[...nodes.entries()].filter(([,node])=>node.cls===cls && expression.test(node.signature)).map(([key])=>key)
  const callback=/^(?:invoke\(|run\(\)V$|onReceive\(Landroid\/content\/Context;Landroid\/content\/Intent;\)V$|on(?:ConnectionStateChange|ServicesDiscovered|MtuChanged|CharacteristicChanged|CharacteristicWrite|DescriptorWrite)\()/
  const walk=roots=>{
    const reached=new Set(),pending=[...roots]
    while(pending.length) {
      const key=pending.shift(),node=nodes.get(key)
      if(reached.has(key)||!node)continue
      if(reached.size>=2048)throw new Error('Diagnostic capture callback method graph exceeds limit')
      reached.add(key)
      for(const [,cls,signature] of node.body.matchAll(/invoke-[^\n]*? (L[^;]+;)->([^\s]+)/g))
        if(nodes.has(`${cls}->${signature}`))pending.push(`${cls}->${signature}`)
      // External Android/queue dispatch invokes only these fixed callback entries
      // on classes actually instantiated by this already-reached method.
      for(const cls of nestedReferences(node.body))
        pending.push(...matching(cls,callback),...matching(cls,/^<init>\(/))
    }
    return reached
  }
  const releaseSignature='releaseOriginalResource(JZLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;Ljava/lang/Long;)V'
  const releaseKey=`${native}->${releaseSignature}`
  const roots=[...matching(native,/^<init>\(\)V$/),...matching(native,/^connectById\(Ljava\/lang\/String;\)V$/),...matching(native,/^findCompatibleDevices\(\)V$/),
    ...matching(native,/^releaseResource(?:\$[A-Za-z0-9_]+)?\(JLkotlin\/jvm\/functions\/Function0;Lkotlin\/jvm\/functions\/Function1;Ljava\/lang\/String;J\)V$/),
    ...matching(native,/^releaseCapturedResource(?:\$[A-Za-z0-9_]+)?\(Lkotlin\/jvm\/functions\/Function0;Lkotlin\/jvm\/functions\/Function1;Ljava\/lang\/String;J\)V$/)]
  const reached=walk(roots)
  const eventRoots={recordResourceFirmwareClock:[native,/^handleRxPacket\(\[B\)V$/],recordResourceTwsClock:[native,/^handleRxPacket\(\[B\)V$/],
    recordResourceTimeAckClock:[native,/^attemptSetTime\(\)V$/],recordResourceTimeWriteClock:[native,/^enqueueWrite\(Landroid\/bluetooth\/BluetoothGattCharacteristic;\[B\)V$/],
    recordResourceMicStopStartedClock:[native,new RegExp(`^${escaped(releaseSignature)}$`)],recordResourceMicStopWrittenClock:[native,new RegExp(`^${escaped(releaseSignature)}$`)],
    recordResourceMicStopMarkerClock:[native.slice(0,-1)+'$gattCallback$1;',/^onCharacteristicChanged\(Landroid\/bluetooth\/BluetoothGatt;Landroid\/bluetooth\/BluetoothGattCharacteristic;\)V$/],
    recordResourceExitClock:[native,/^<init>\(\)V$/]}
  const recorderConsumed=name=>{
    const [cls,expression]=eventRoots[name]
    const event=matching(cls,expression).filter(key=>reached.has(key))
    return walk(event).has(`${native}->${name}()V`)
  }
  const recorder={firmwareElapsedMs:'recordResourceFirmwareClock',twsElapsedMs:'recordResourceTwsClock',timeWriteStartedElapsedMs:'recordResourceTimeWriteClock',timeAckElapsedMs:'recordResourceTimeAckClock',micStopStartedElapsedMs:'recordResourceMicStopStartedClock',micStopMarkerElapsedMs:'recordResourceMicStopMarkerClock',micStopWrittenElapsedMs:'recordResourceMicStopWrittenClock',displayExitElapsedMs:'recordResourceExitClock'}
  const clockBody = field => recorder[field] ? method(nimo ?? '', `${recorder[field]}()V`) : field === 'resourceSessionStartedElapsedMs' ? method(nimo ?? '', 'connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V') : (nodes.get(releaseKey)?.body ?? '')
  const monotonicWrite = field => new RegExp(`invoke-static\\s+\\{\\},\\s*${elapsed}\\s*\\n\\s*move-result-wide\\s+([vp][0-9]+)\\s*\\n\\s*iput-wide\\s+\\1,\\s*[vp][0-9]+,\\s*${escaped(descriptor(NIMO_DEVICE))}->${field}:J`).test(clockBody(field).replace(/^\s*\.(?:line|local|end local|restart local)\b[^\n]*$/gm,''))
  // Nullable event values compile to boxed Long. Bind the sampled wide register
  // through valueOf and its object register to the exact event field assignment.
  const boxedMonotonicWrite = field => new RegExp(`invoke-static\\s+\\{\\},\\s*${elapsed}\\s*\\n\\s*move-result-wide\\s+([vp][0-9]+)\\s*\\n\\s*invoke-static(?:/range)?\\s+\\{\\1(?:,\\s*[vp][0-9]+|\\s+\\.\\.\\s+[vp][0-9]+)?\\},\\s*Ljava/lang/Long;->valueOf\\(J\\)Ljava/lang/Long;\\s*\\n\\s*move-result-object\\s+([vp][0-9]+)\\s*\\n\\s*iput-object\\s+\\2,\\s*[vp][0-9]+,\\s*${escaped(descriptor(NIMO_DEVICE))}->${field}:Ljava/lang/Long;`).test(clockBody(field).replace(/^\s*\.(?:line|local|end local|restart local)\b[^\n]*$/gm,''))
  const eventFields=['resourceSessionStartedElapsedMs','resourceReleaseStartedElapsedMs','firmwareElapsedMs','twsElapsedMs','timeWriteStartedElapsedMs','timeAckElapsedMs','micStopStartedElapsedMs','micStopMarkerElapsedMs','micStopWrittenElapsedMs','displayExitElapsedMs']
  if (!diagnostics.includes(`"${CLOCK_PROTOCOL}"`) || !invoke(diagnostics,elapsed) || !invoke(nativeSnapshot,elapsed) ||
      !reached.has(`${native}->connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V`) ||
      !reached.has(releaseKey) ||
      eventFields.some(field=>!boxedMonotonicWrite(field) && !monotonicWrite(field)) ||
      Object.values(recorder).some(name=>!recorderConsumed(name)) ||
      !diagnostics.includes('"requestReceivedElapsedMs"') || !diagnostics.includes('"android-elapsed-realtime-v1"') ||
      clockFields.some(field=>!nativeSnapshot.includes(`"${field}"`)) ||
      !invoke(captureAdmission,`${escaped(descriptor(NIMO_DEVICE))}->resourceCaptureAdmission(?:\\$[A-Za-z0-9_]+)?\\(Ljava/lang/String;JJ\\)V`) ||
      !invoke(fixedExecute,`${escaped(descriptor(NIMO_DEVICE))}->releaseCapturedResource(?:\\$[A-Za-z0-9_]+)?\\(Lkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J\\)V`) ||
      !invoke(fixedExecute,`${escaped(native)}->releaseResource(?:\\$[A-Za-z0-9_]+)?\\(JLkotlin/jvm/functions/Function0;Lkotlin/jvm/functions/Function1;Ljava/lang/String;J\\)V`) ||
      !invoke(method(nimo ?? '','connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V'),elapsed))
    throw new Error('Diagnostic APK lacks compiled capture monotonic receipt clock and original causal anchors')

  // Verify actual call sites and consumed boolean guards, not capability strings alone.
  const guarded = (body, name) => {
    const instructions = body.replace(/^\s*(?:#.*|\.(?:line|local|end local|restart local|prologue|epilogue)\b[^\n]*)$/gm,'')
    const args = name === 'dispatchCapturedEntry' ? 'Lkotlin/jvm/functions/Function0;' :
      ['allowManagerConnect','preserveCapturedScan'].includes(name) ? 'Ljava/lang/String;Ljava/lang/String;' :
      `${descriptor(NIMO_DEVICE)}Ljava/lang/String;Z`
    const normal = `${name}\\(${escaped(args)}\\)Z`
    const bridge = name === 'allowManagerConnect' ? `|${name}\\$default\\(${escaped(target + args + 'ILjava/lang/Object;')}\\)Z` : ''
    return new RegExp(`invoke-[^\\n]+${escaped(target)}->(?:${normal}${bridge})\\s*\\n\\s*move-result\\s+([vp][0-9]+)\\s*\\n\\s*if-(?:eqz|nez)\\s+\\1\\s*,`).test(instructions)
  }
  const checks = [
    [sdk, NIMO_SDK, 'connect(Lcom/mentra/bluetoothsdk/Device;Lcom/mentra/bluetoothsdk/ConnectOptions;)V', ['dispatchCapturedEntry','allowManagerConnect','preserveCapturedScan']],
    [sdk, NIMO_SDK, 'connectDefault(Lcom/mentra/bluetoothsdk/ConnectOptions;)V', ['dispatchCapturedEntry','allowManagerConnect','preserveCapturedScan']],
    [sdk, NIMO_SDK, 'startScan(Lcom/mentra/bluetoothsdk/DeviceModel;)V', ['dispatchCapturedEntry','allowManagerConnect']],
    [manager, NIMO_MANAGER, 'connectByName(Ljava/lang/String;)V', ['dispatchCapturedEntry','allowManagerConnect','preserveCapturedScan']],
    [manager, NIMO_MANAGER, 'connectDefault()V', ['dispatchCapturedEntry','allowManagerConnect']],
    [nimo, NIMO_DEVICE, 'connectById(Ljava/lang/String;)V', ['dispatchCapturedEntry','admit']],
    [nimo, NIMO_DEVICE, 'findCompatibleDevices()V', ['dispatchCapturedEntry','admit']],
    [nimo, NIMO_DEVICE, 'connectCompanionGatt(Landroid/bluetooth/BluetoothDevice;)V', ['allowPeer']],
    [nimo, NIMO_DEVICE, 'startBond(Landroid/bluetooth/BluetoothDevice;)V', ['allowPeer']],
    [nimo, NIMO_DEVICE, 'connectBredrTransport(Landroid/bluetooth/BluetoothDevice;)V', ['beginTransport']],
  ]
  const execute = method(diagnostics, 'execute$bluetooth_sdk_nimoDiagnostic(Landroid/content/Intent;)V') ||
    [...diagnostics.matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)].find(v=>/execute(?:\$[A-Za-z0-9_]+)?\(Landroid\/content\/Intent;\)V$/.test(v[1]))?.[2] || ''
  const snapshot = [...diagnostics.matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)].find(v=>/captureSnapshot\(/.test(v[1]))?.[2] || ''
  const dispatch = method(diagnostics,'dispatchCapturedEntry(Lkotlin/jvm/functions/Function0;)Z')
  const named = expression => [...diagnostics.matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)].find(v=>expression.test(v[1].trim()))?.[2] || ''
  const policyName = 'preArmCaptureRequired(?:\\$[A-Za-z0-9_]+)?'
  const policy = named(/ preArmCaptureRequired(?:\$[A-Za-z0-9_]+)?\(Ljava\/lang\/String;\)Z$/)
  const defaults = named(/ preArmCaptureRequired(?:\$[A-Za-z0-9_]+)?\$default\(/)
  const unarmed = named(/ allowUnarmedWearable(?:\$[A-Za-z0-9_]+)?\(Ljava\/lang\/String;Ljava\/lang\/String;\)Z$/)
  const policyCall = `${escaped(target)}->${policyName}\\(Ljava/lang/String;\\)Z`
  const defaultCall = `${escaped(target)}->${policyName}\\$default\\(${escaped(target)}Ljava/lang/String;ILjava/lang/Object;\\)Z`
  const consumed = (body, reference, jsonField) => {
    // This is a bounded straight-line compiler pattern, not a control-flow proof.
    // A boolean inversion is useful only when its destination reaches the sink.
    const instructions = body.split('\n').map(line=>line.trim()).filter(line=>line &&
      !/^(?:#|\.(?:line|local|end local|restart local|prologue|epilogue)\b)/.test(line))
    const call = new RegExp(`^invoke-[^\\n]+${reference}$`)
    return instructions.some((line,index)=>{
      if (!call.test(line)) return false
      let register = /^move-result\s+([vp][0-9]+)$/.exec(instructions[index+1] ?? '')?.[1]
      if (!register) return false
      const postCallWrites=new Set([register])
      let next = index+2
      const constants = new Map()
      // Recover only straight-line literal assignments, never across a label or
      // branch. Kotlin/D8 can materialize boolean one before the policy call.
      for (let prior=index-1; prior>=Math.max(0,index-12); prior--) {
        const value=instructions[prior]
        if (/^(?::|(?:if-|goto|return|throw|invoke-))/.test(value)) break
        const write=/^[a-z][a-z0-9/-]*\s+([vp][0-9]+)(?:\s*,|$)/.exec(value)
        if (!write || constants.has(write[1])) continue
        const literal=/^const(?:\/4|\/16)?\s+([vp][0-9]+),\s*(0x[0-9a-f]+|[0-9]+)$/.exec(value)
        constants.set(write[1], literal ? Number(literal[2]) : null)
      }
      constants.delete(register) // move-result overwrote any pre-call literal.
      let inverted=false
      for (let steps=0; steps<8; steps++) {
        const value=instructions[next] ?? ''
        const literal=/^const(?:\/4|\/16)?\s+([vp][0-9]+),\s*(0x[0-9a-f]+|[0-9]+)$/.exec(value)
        if (literal) {
          if (literal[1] === register) return false
          constants.set(literal[1],Number(literal[2])); postCallWrites.add(literal[1]); next++; continue
        }
        const stringLiteral=/^const-string(?:\/jumbo)?\s+([vp][0-9]+),\s*"[^"\n]*"$/.exec(value)
        if (stringLiteral) {
          if (stringLiteral[1] === register) return false
          constants.set(stringLiteral[1],null); postCallWrites.add(stringLiteral[1]); next++; continue
        }
        const inversion=/^xor-int\/lit8\s+([vp][0-9]+),\s*([vp][0-9]+),\s*(?:0x1|1)$/.exec(value)
        const twoAddress=/^xor-int\/2addr\s+([vp][0-9]+),\s*([vp][0-9]+)$/.exec(value)
        if (!inverted && inversion && inversion[2]===register) {
          register=inversion[1]; postCallWrites.add(register); constants.delete(register); inverted=true; next++; continue
        }
        if (!inverted && twoAddress && twoAddress[1]===register && twoAddress[2]!==register && constants.get(twoAddress[2])===1) {
          inverted=true; next++; continue
        }
        break
      }
      const sink = instructions[next] ?? ''
      if (!jsonField) return new RegExp(`^(?:return\\s+${register}$|if-(?:eqz|nez)\\s+${register}\\s*,)`).test(sink)
      const put = /^invoke-virtual\s+\{([vp][0-9]+),\s*([vp][0-9]+),\s*([vp][0-9]+)\},\s*Lorg\/json\/JSONObject;->put\(Ljava\/lang\/String;Z\)Lorg\/json\/JSONObject;$/.exec(sink)
      if (!put || put[3] !== register || postCallWrites.has(put[1]) || put[1]===put[2]) return false
      // The key's most recent assignment must be the expected literal. Do not
      // borrow a literal whose register was subsequently overwritten.
      for (let previous=next-1; previous>=Math.max(0,index-12); previous--) {
        const value = instructions[previous]
        if (/^(?::|(?:if-|goto|return|throw))/.test(value) || previous!==index && /^invoke-/.test(value)) return false
        if (new RegExp(`^[a-z][a-z0-9/-]*\\s+${put[2]}(?:\\s*,|$)`).test(value))
          return new RegExp(`^const-string(?:/jumbo)?\\s+${put[2]},\\s*"${escaped(jsonField)}"$`).test(value)
      }
      return false
    })
  }
  const diagnosticLiteral = (body, reference) => new RegExp(`const-string(?:/jumbo)?\\s+([vp][0-9]+),\\s*"nimoDiagnostic"[\\s\\S]*?invoke-[^\\n]+\\{[^}]*\\b\\1\\b[^}]*\\}[^\\n]*${reference}`).test(body)
  const policyObligations = [
    ['policy equality', diagnosticLiteral(policy,'Lkotlin/jvm/internal/Intrinsics;->areEqual') && consumed(policy,'Lkotlin/jvm/internal/Intrinsics;->areEqual\\(Ljava/lang/Object;Ljava/lang/Object;\\)Z')],
    ['diagnostic default', diagnosticLiteral(defaults,policyCall) && consumed(defaults,policyCall)],
    ['manager unarmed gate', diagnosticLiteral(method(diagnostics,'allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z'),`${escaped(target)}->allowUnarmedWearable`) && consumed(method(diagnostics,'allowManagerConnect(Ljava/lang/String;Ljava/lang/String;)Z'), `${escaped(target)}->allowUnarmedWearable(?:\\$[A-Za-z0-9_]+)?\\(Ljava/lang/String;Ljava/lang/String;\\)Z`)],
    ['unarmed wearable policy', consumed(unarmed,policyCall) && /const-string(?:\/jumbo)?[^\n]*"NIMO"/.test(unarmed)],
    ...['admit','allowPeer','beginTransport'].map(name=>[name,consumed(method(diagnostics,`${name}(${descriptor(NIMO_DEVICE)}Ljava/lang/String;Z)Z`),defaultCall)]),
    ['captureRequiredBeforeArm JSON field', consumed(snapshot,defaultCall,'captureRequiredBeforeArm')],
  ]
  const failedPolicy=policyObligations.filter(([,valid])=>!valid).map(([name])=>name)
  if (failedPolicy.length) throw new Error(`Diagnostic APK lacks compiled diagnostic-only deny-before-arm policy wiring: ${failedPolicy.join(', ')}`)


  if (checks.some(([code, cls, signature, guards]) => !hasClass(code ?? '',descriptor(cls)) || guards.some(guard=>!guarded(method(code,signature),guard))) ||
      ['arm-capture','capture-status','cancel-capture'].some(value=>!execute.includes(`"${value}"`)) ||
      !snapshot.includes(`"${CAPTURE_PROTOCOL}"`) ||
      !invoke(execute, `${escaped(descriptor(NIMO_DEVICE))}->releaseCapturedResource(?:\\$[A-Za-z0-9_]+)?\\(`) ||
      !invoke(dispatch, 'Landroid/os/Handler;->post\\(') ||
      !invoke(dispatch, 'Ljava/util/concurrent/FutureTask;->get\\(') ||
      !invoke(dispatch, 'Ljava/util/concurrent/FutureTask;->cancel\\('))
    throw new Error('Diagnostic APK lacks compiled pre-connect capture protocol and SDK/NIMO admission guards')
}
/** Only installed SDK packages are eligible; neither PATH nor a caller tool path is a fallback. */
export async function resolveAndroidSdkAnalyzer(sdkHome) {
  if (typeof sdkHome !== 'string' || !path.isAbsolute(sdkHome)) throw new Error('Android SDK root must be absolute')
  const sdk = await realpath(sdkHome), commandTools = await realpath(path.join(sdk, 'cmdline-tools'))
  if (!commandTools.startsWith(sdk + path.sep)) throw new Error('Android SDK command tools escape the SDK root')
  const entries = await readdir(commandTools, {withFileTypes:true})
  if (entries.length > 64) throw new Error('Android SDK command-tool package count exceeds limit')
  const packages = new Map()
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    if (!/^(?:latest|[0-9][0-9A-Za-z_.-]{0,79})$/.test(entry.name)) continue
    try {
      const root = await realpath(path.join(commandTools,entry.name))
      // Canonicalize a latest alias before hashing; never inspect tools outside this SDK.
      if (path.dirname(root) !== commandTools || packages.has(root) || !(await stat(root)).isDirectory()) continue
      const analyzer = await realpath(path.join(root,'bin','apkanalyzer'))
      if (!analyzer.startsWith(root + path.sep) || !(await stat(analyzer)).isFile()) continue
      await access(analyzer,constants.X_OK)
      const propertiesFile = path.join(root,'source.properties')
      if (await realpath(propertiesFile) !== propertiesFile) continue
      const properties = await readFile(propertiesFile,'utf8')
      if (Buffer.byteLength(properties) > 8192) continue
      const revision = /^Pkg.Revision\s*=\s*([0-9]+(?:\.[0-9]+)*)\s*$/m.exec(properties)?.[1]
      if (!revision) continue
      packages.set(root,{analyzer,root,revision})
    } catch (error) {
      if (!['ENOENT','ENOTDIR','EACCES'].includes(error?.code)) throw error
    }
  }
  const selected = [...packages.values()].sort((a,b)=>b.revision.localeCompare(a.revision,undefined,{numeric:true}) || a.root.localeCompare(b.root))[0]
  if (!selected) throw new Error('No executable Android SDK apkanalyzer with package provenance is installed')
  return selected
}
export async function inspectNimoDiagnosticBytecode(apk, sdkHome, exec) {
  const {analyzer,root,revision} = await resolveAndroidSdkAnalyzer(sdkHome), digest = createHash('sha256')
  let total = 0, files = 0
  const hashFile = async file => { const bytes = await readFile(file); total += bytes.length; files++
    if (total > 1024 ** 3 || files > 1000) throw new Error('Android SDK analyzer provenance exceeds limit')
    digest.update(path.relative(root, file)).update('\0').update(createHash('sha256').update(bytes).digest()) }
  const walk = async directory => { for (const entry of (await readdir(directory, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file = path.join(directory,entry.name)
    if (entry.isDirectory()) await walk(file)
    else if (entry.isFile()) await hashFile(file)
    else throw new Error('Android SDK analyzer provenance cannot follow links')
  } }
  await hashFile(analyzer); await hashFile(path.join(root,'source.properties')); await walk(path.join(root,'lib'))
  const read = name => exec(analyzer, ['dex', 'code', '--class', name, apk], {encoding:'utf8', maxBuffer:16 * 1024 * 1024})
  const code = {diagnostics:read(NIMO_DIAGNOSTIC), receiver:read(NIMO_RECEIVER), manager:read(NIMO_MANAGER), sdk:read(NIMO_SDK), nimo:read(NIMO_DEVICE)}
  // Follow only instantiated Nimo-owned callback classes. No caller class/path
  // input, package-wide scan, or arbitrary bytecode surface is accepted.
  code.nestedNimo={}
  const references=text=>[...text.matchAll(/^\s*new-instance[^\n]* (Lcom\/mentra\/bluetoothsdk\/sgcs\/Nimo\$[A-Za-z0-9_$]+;)/gm)].map(v=>v[1])
  const pending=references(code.nimo)
  let nestedBytes=0
  while (pending.length) {
    const cls=pending.shift()
    if (Object.hasOwn(code.nestedNimo,cls)) continue
    if (Object.keys(code.nestedNimo).length >= 128) throw new Error('Nimo callback class count exceeds limit')
    const text=read(cls.slice(1,-1).replaceAll('/','.'))
    nestedBytes+=Buffer.byteLength(text)
    if(nestedBytes>64*1024*1024) throw new Error('Nimo callback disassembly exceeds limit')
    code.nestedNimo[cls]=text
    pending.push(...references(text))
  }
  validateNimoDiagnosticBytecode(code)
  return {clockProtocol:CLOCK_PROTOCOL, captureProtocol:CAPTURE_PROTOCOL, captureRequiredBeforeArm:true, scanInstancePreserved:true, analyzer:{source:'android-sdk-command-line-tools',revision,sha256:digest.digest('hex')}, wiringSha256:createHash('sha256').update(JSON.stringify(code)).digest('hex')}
}
