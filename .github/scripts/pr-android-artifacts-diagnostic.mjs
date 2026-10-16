import {createHash} from 'node:crypto'
import {readFile, readdir} from 'node:fs/promises'
import path from 'node:path'
// Android SDK apkanalyzer disassembles the actual signed artifact, never source or caller metadata.
export const NIMO_DIAGNOSTIC = 'com.mentra.bluetoothsdk.sgcs.NimoResourceDiagnostics'
export const NIMO_RECEIVER = `${NIMO_DIAGNOSTIC}$receiver$1`
export const NIMO_MANAGER = 'com.mentra.bluetoothsdk.DeviceManager'
const descriptor = name => `L${name.replaceAll('.', '/')};`
const escaped = value => [...value].map(char => '\\^$.*+?()[]{}|'.includes(char) ? '\\' + char : char).join('')
function method(code, signature) {
  const methods = [...code.matchAll(/^\.method\b([^\n]*)\n([\s\S]*?)^\.end method\s*$/gm)]
  return methods.find(value => value[1].trim().endsWith(signature))?.[2] ?? ''
}
export function validateNimoDiagnosticBytecode({diagnostics, receiver, manager}) {
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
      !invoke(start, 'Landroid/content/Context;->registerReceiver\\(') ||
      !new RegExp(`new-instance[^\\n]*${escaped(child)}`).test(method(diagnostics, '<clinit>()V')) ||
      !invoke(receive, `${escaped(target)}->execute(?:\\$[A-Za-z0-9_]+)?\\(Landroid/content/Intent;\\)V`) ||
      !invoke(manager, `${escaped(target)}->start\\(Landroid/content/Context;\\)V`))
    throw new Error('Diagnostic APK lacks compiled NIMO receiver class and registration/startup wiring')
}
export async function inspectNimoDiagnosticBytecode(apk, analyzer, exec) {
  const read = name => exec(analyzer, ['dex', 'code', '--class', name, apk], {encoding:'utf8', maxBuffer:16 * 1024 * 1024})
  const code = {diagnostics:read(NIMO_DIAGNOSTIC), receiver:read(NIMO_RECEIVER), manager:read(NIMO_MANAGER)}
  validateNimoDiagnosticBytecode(code)
  const root = path.dirname(path.dirname(analyzer)), digest = createHash('sha256')
  const properties = await readFile(path.join(root, 'source.properties'), 'utf8')
  const revision = /^Pkg.Revision\s*=\s*([0-9.]+)\s*$/m.exec(properties)?.[1]
  if (!revision) throw new Error('Android SDK analyzer has no package revision provenance')
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
  return {analyzer:{source:'android-sdk-command-line-tools',revision,sha256:digest.digest('hex')}, wiringSha256:createHash('sha256').update(JSON.stringify(code)).digest('hex')}
}
