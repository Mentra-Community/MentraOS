import {createHash} from "node:crypto"
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"

export const root = resolve(import.meta.dir, "../../..")
export const bin = resolve(root, ".test-results/mentra-e2e/bin/mentra-driver")

export interface Frame {
  x: number
  y: number
  width: number
  height: number
}
export interface Selector {
  role?: string
  subrole?: string
  title?: string
  description?: string
  value?: string
  placeholder?: string
  identifier?: string
  identifierPrefix?: string
  text?: string
  contains?: string
  enabled?: boolean
  focused?: boolean
  visible?: boolean
  ancestor?: Selector
}
export interface Element {
  path: string
  role: string
  subrole: string
  title: string
  description: string
  placeholder: string
  identifier: string
  value: string
  enabled: boolean
  focused: boolean
  visible: boolean
  frame?: Frame
  actions: string[]
}
export interface Snapshot {
  pid: number
  frontmostBundleId: string
  window: Frame
  elements: Element[]
}
export interface Doctor {
  accessibility: boolean
  screenCapture: boolean
  postEvents: boolean
  frontmostBundleId: string
  pid: number
  bundleId: string
  bundlePath: string
  executablePath: string
  javascriptPath: string
  version: string
  build: string
}
export interface Command {
  op: string
  selector?: Selector
  method?: "ax-value"
  text?: string
  action?: string
  path?: string
}

export async function buildDriver() {
  await mkdir(resolve(bin, ".."), {recursive: true})
  const native = resolve(root, "tools/mentra-e2e/native")
  const sources = (await readdir(native))
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => resolve(native, name))
  const compiler = Bun.spawn(["swiftc", "--version"], {stdout: "pipe", stderr: "pipe"})
  const version = await new Response(compiler.stdout).text()
  if (await compiler.exited) throw new Error("swiftc is unavailable")
  const hash = createHash("sha256").update(version).update("swift6-v1")
  for (const source of sources) hash.update(await readFile(source))
  const fingerprint = hash.digest("hex")
  const stamp = `${bin}.source-hash`
  if (
    (await Bun.file(bin).exists()) &&
    (await Bun.file(stamp)
      .text()
      .catch(() => "")) === fingerprint
  )
    return
  const build = Bun.spawn(["swiftc", "-swift-version", "6", "-parse-as-library", ...sources, "-o", bin], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(build.stderr).text()
  if (await build.exited) throw new Error(`Native driver compilation failed:\n${stderr}`)
  await writeFile(stamp, fingerprint)
}

export async function command<T = Record<string, unknown>>(input: Command, timeoutMs = 15000): Promise<T> {
  const child = Bun.spawn([bin], {stdin: "pipe", stdout: "pipe", stderr: "pipe"})
  child.stdin.write(JSON.stringify(input))
  child.stdin.end()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timedOut) throw new Error(`Native ${input.op} exceeded ${timeoutMs} ms`)
    let response: {ok: boolean; result?: T; error?: string}
    try {
      response = JSON.parse(stdout)
    } catch {
      throw new Error(`Native ${input.op} returned invalid JSON (exit ${exitCode})`)
    }
    if (!response.ok || exitCode) throw new Error(response.error ?? `Native ${input.op} failed (exit ${exitCode})`)
    if (!response.result) throw new Error(`Native ${input.op} returned no result`)
    return response.result
  } finally {
    clearTimeout(timer)
  }
}

export function match(element: Element, selector: Selector, snapshot: Snapshot): boolean {
  for (const key of [
    "role",
    "subrole",
    "title",
    "description",
    "value",
    "placeholder",
    "identifier",
    "enabled",
    "focused",
  ] as const) {
    if (selector[key] !== undefined && element[key] !== selector[key]) return false
  }
  const texts = [element.title, element.description, element.value, element.placeholder]
  if (selector.identifierPrefix !== undefined && !element.identifier.startsWith(selector.identifierPrefix)) return false
  if (selector.text !== undefined && !texts.includes(selector.text)) return false
  if (selector.contains !== undefined && !texts.some((text) => text.includes(selector.contains!))) return false
  if (selector.visible !== false && !element.visible) return false
  if (
    selector.ancestor &&
    !snapshot.elements.some(
      (parent) =>
        element.path.startsWith(`${parent.path}.`) && match(parent, {...selector.ancestor, visible: false}, snapshot),
    )
  )
    return false
  return true
}

export async function snapshot() {
  return command<Snapshot>({op: "snapshot"})
}
export function visible(state: Snapshot, selector: Selector) {
  return state.elements.filter((element) => match(element, selector, state))
}

export function compact(state: Snapshot) {
  return state.elements
    .filter(
      (element) =>
        element.visible &&
        (element.description || element.title || element.placeholder || element.role === "AXTextField"),
    )
    .map((element) => ({
      role: element.role,
      subrole: element.subrole,
      identifier: element.identifier,
      actions: element.actions,
      description: element.description,
      title: element.title,
      placeholder: element.placeholder,
      value: element.value,
      frame: element.frame,
    }))
}
