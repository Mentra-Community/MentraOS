import {renderHook} from "@testing-library/react-native"

import {useKeepAwakeWhile} from "./useKeepAwakeWhile"

const mockActivate = jest.fn<Promise<void>, [string]>(() => Promise.resolve())
const mockDeactivate = jest.fn<Promise<void>, [string]>(() => Promise.resolve())

jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: (tag: string) => mockActivate(tag),
  deactivateKeepAwake: (tag: string) => mockDeactivate(tag),
}))

beforeEach(() => {
  mockActivate.mockClear()
  mockDeactivate.mockClear()
})

describe("useKeepAwakeWhile", () => {
  it("does nothing while inactive", () => {
    renderHook(() => useKeepAwakeWhile(false, "ota"))
    expect(mockActivate).not.toHaveBeenCalled()
    expect(mockDeactivate).not.toHaveBeenCalled()
  })

  it("activates when active and releases when it turns inactive", () => {
    const {rerender} = renderHook(({active}: {active: boolean}) => useKeepAwakeWhile(active, "ota"), {
      initialProps: {active: false},
    })

    rerender({active: true})
    expect(mockActivate).toHaveBeenCalledWith("ota")
    expect(mockDeactivate).not.toHaveBeenCalled()

    rerender({active: false})
    expect(mockDeactivate).toHaveBeenCalledWith("ota")
  })

  it("releases on unmount", () => {
    const {unmount} = renderHook(() => useKeepAwakeWhile(true, "ota"))
    expect(mockActivate).toHaveBeenCalledTimes(1)

    unmount()
    expect(mockDeactivate).toHaveBeenCalledWith("ota")
  })
})
