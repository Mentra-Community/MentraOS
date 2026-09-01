import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("publishes externally managed streaming on the frozen root API", () => {
  const source = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")
  const publicObject = extractDelimitedInitializer(source, "export const BluetoothSdk", "Object.freeze", "{", "}")
  assertBoundMethod(publicObject, "startExternallyManagedStream")
  assertBoundMethod(publicObject, "sendExternallyManagedStreamKeepAlive")

  const publicEvents = extractDelimitedInitializer(source, "const PUBLIC_EVENT_NAMES", "new Set", "[", "]")
  assert.ok(
    splitTopLevel(publicEvents)
      .map((item) => item.trim())
      .includes('"keep_alive_ack"'),
  )
})

function extractDelimitedInitializer(source, declaration, initializer, open, close) {
  const declarationIndex = source.indexOf(declaration)
  assert.notEqual(declarationIndex, -1, `missing ${declaration}`)
  const initializerIndex = source.indexOf(initializer, declarationIndex)
  assert.notEqual(initializerIndex, -1, `missing ${initializer} initializer for ${declaration}`)
  const openIndex = source.indexOf(open, initializerIndex)
  assert.notEqual(openIndex, -1, `missing ${open} after ${initializer}`)
  return extractBalanced(source, openIndex, open, close)
}

function assertBoundMethod(publicObject, methodName) {
  const property = splitTopLevel(publicObject).find((item) => item.trimStart().startsWith(`${methodName}:`))
  assert.ok(property, `missing ${methodName} public method`)
  assert.equal(property.replace(/\s+/g, " ").trim(), `${methodName}: bindPublicMethod("${methodName}")`)
}

function extractBalanced(source, openIndex, open, close) {
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (character === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (character === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === open) depth += 1
    if (character !== close) continue
    depth -= 1
    if (depth === 0) return source.slice(openIndex + 1, index)
  }

  assert.fail(`unterminated ${open}${close} initializer`)
}

function splitTopLevel(source) {
  const items = []
  let start = 0
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (character === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "(" || character === "[" || character === "{") depth += 1
    if (character === ")" || character === "]" || character === "}") depth -= 1
    if (character === "," && depth === 0) {
      items.push(source.slice(start, index))
      start = index + 1
    }
  }
  items.push(source.slice(start))
  return items
}

test("publishes externally managed streaming methods and request types", () => {
  const types = readFileSync(path.join(packageRoot, "src/BluetoothSdk.types.ts"), "utf8")
  const root = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")

  assert.match(types, /export type StreamKeepAliveRequest =/)
  assert.match(types, /startExternallyManagedStream\(params: StreamStartRequest\): Promise<StreamStatusEvent>/)
  assert.match(types, /sendExternallyManagedStreamKeepAlive\(params: StreamKeepAliveRequest\): Promise<void>/)
  assert.match(types, /keep_alive_ack: KeepAliveAckEvent/)
  assert.match(root, /\bStreamKeepAliveRequest,\n/)
  assert.match(root, /\bKeepAliveAckEvent,\n/)
})

test("keeps the public methods backed by both native bridges", () => {
  const android = readFileSync(
    path.join(packageRoot, "android/src/main/java/com/mentra/bluetoothsdk/BluetoothSdkModule.kt"),
    "utf8",
  )
  const ios = readFileSync(path.join(packageRoot, "ios/BluetoothSdkModule.swift"), "utf8")

  for (const method of ["startExternallyManagedStream", "sendExternallyManagedStreamKeepAlive"]) {
    assert.ok(android.includes(`"${method}"`), `missing Android bridge method: ${method}`)
    assert.ok(ios.includes(`"${method}"`), `missing iOS bridge method: ${method}`)
  }
})
