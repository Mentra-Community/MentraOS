import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"
import ts from "typescript"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("publishes externally managed streaming on the frozen root API", () => {
  const source = readFileSync(path.join(packageRoot, "src/index.ts"), "utf8")
  const sourceFile = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bluetoothSdk = findVariable(sourceFile, "BluetoothSdk")
  const publicEvents = findVariable(sourceFile, "PUBLIC_EVENT_NAMES")

  assert.ok(bluetoothSdk && ts.isCallExpression(bluetoothSdk), "missing frozen BluetoothSdk public object")
  assert.equal(bluetoothSdk.expression.getText(), "Object.freeze")
  const publicObject = bluetoothSdk.arguments[0]
  assert.ok(publicObject && ts.isObjectLiteralExpression(publicObject), "BluetoothSdk must freeze an object literal")
  assertBoundMethod(publicObject, "startExternallyManagedStream")
  assertBoundMethod(publicObject, "sendExternallyManagedStreamKeepAlive")

  assert.ok(publicEvents && ts.isNewExpression(publicEvents), "missing BluetoothSdk public event allowlist")
  const eventNames = publicEvents.arguments?.[0]
  assert.ok(eventNames && ts.isArrayLiteralExpression(eventNames), "public event allowlist must be an array")
  assert.ok(
    eventNames.elements.some((element) => ts.isStringLiteral(element) && element.text === "keep_alive_ack"),
    "missing keep_alive_ack public event",
  )
})

function findVariable(sourceFile, name) {
  let initializer
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    const declaration = node.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    )
    if (declaration) initializer = declaration.initializer
  })
  return initializer
}

function assertBoundMethod(publicObject, methodName) {
  const property = publicObject.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText() === methodName,
  )
  assert.ok(property && ts.isCallExpression(property.initializer), `missing ${methodName} public method`)
  assert.equal(property.initializer.expression.getText(), "bindPublicMethod")
  assert.equal(property.initializer.arguments[0]?.getText(), `"${methodName}"`)
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
