import {storage} from "@/utils/storage/storage"
import {Result} from "typesafe-ts"

const VALUE_OBJECT = {x: 1}

function expectOk<T>(result: Result<T, Error>): T {
  expect(result.is_ok()).toBe(true)
  if (result.is_error()) {
    throw result.error
  }
  return result.value
}

describe("MMKV Storage", () => {
  beforeEach(() => {
    storage.clearAll()
    storage.save("string", "string")
    storage.save("object", VALUE_OBJECT)
  })

  it("should be defined", () => {
    expect(storage).toBeDefined()
  })

  it("should have default keys", () => {
    expect(storage.getAllKeys()).toEqual(["string", "object"])
  })

  it("should load data", () => {
    const objectResult = storage.load<object>("object")
    expect(expectOk(objectResult)).toEqual(VALUE_OBJECT)

    const stringResult = storage.load<string>("string")
    expect(expectOk(stringResult)).toEqual("string")
  })

  it("should save objects", () => {
    storage.save("object", {y: 2})
    expect(expectOk(storage.load<object>("object"))).toEqual({y: 2})
    storage.save("object", {z: 3, also: true})
    expect(expectOk(storage.load<object>("object"))).toEqual({z: 3, also: true})
  })

  it("should remove data", () => {
    storage.remove("object")
    expect(storage.load<object>("object").is_error()).toBe(true)
    expect(storage.getAllKeys()).toEqual(["string"])

    storage.remove("string")
    expect(storage.load<string>("string").is_error()).toBe(true)
    expect(storage.getAllKeys()).toEqual([])
  })

  it("should clear all data", () => {
    expect(storage.getAllKeys()).toEqual(["string", "object"])
    storage.clearAll()
    expect(storage.getAllKeys()).toEqual([])
  })
})
