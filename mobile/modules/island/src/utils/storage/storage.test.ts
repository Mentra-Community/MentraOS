import {storage} from "@/utils/storage/storage"

const VALUE_OBJECT = {x: 1}

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
    expect(objectResult.is_ok()).toBe(true)
    expect(objectResult.value).toEqual(VALUE_OBJECT)

    const stringResult = storage.load<string>("string")
    expect(stringResult.is_ok()).toBe(true)
    expect(stringResult.value).toEqual("string")
  })

  it("should save objects", () => {
    storage.save("object", {y: 2})
    expect(storage.load<object>("object").value).toEqual({y: 2})
    storage.save("object", {z: 3, also: true})
    expect(storage.load<object>("object").value).toEqual({z: 3, also: true})
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
