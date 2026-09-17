import {expect, test} from "bun:test"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {androidNodes, AndroidSession} from "./android-session"

test("Android semantic dump retains IDs and decodes UI text", () => {
  expect(
    androidNodes(
      '<hierarchy><node text="Update &amp; restart" content-desc="" resource-id="button-Update Now" /></hierarchy>',
    ),
  ).toEqual([{text: "Update & restart", description: "", id: "button-Update Now"}])
})
test("An incomplete UI dump cannot be treated as an empty successful screen", () => {
  expect(() => androidNodes('<hierarchy><node text="Update Complete"/>')).toThrow("Incomplete")
})
test("Recorder requires an explicit safe device and physical display", () => {
  expect(() => new AndroidSession("device;anything", "123", "test", "/tmp/test")).toThrow()
  expect(() => new AndroidSession("ZY22JWCN97", "default", "test", "/tmp/test")).toThrow()
})

test("A duplicate run directory preserves the original evidence during cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mentra-android-existing-"))
  try {
    await writeFile(join(directory, "result.json"), "original evidence")
    const session = new AndroidSession("example-phone", "123", "test", directory)
    await expect(session.start()).rejects.toThrow()
    await session.finish("failed")
    expect(await readFile(join(directory, "result.json"), "utf8")).toBe("original evidence")
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
