import {router} from "expo-router"

import {useNavigationStore} from "@/stores/navigation"

jest.mock("expo-router", () => ({
  router: {push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissAll: jest.fn(), dismissTo: jest.fn()},
}))

const replace = router.replace as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  useNavigationStore.setState({history: [], historyParams: []})
})

describe("clearHistoryAndGoHome", () => {
  it("keeps Home when it is already the only screen", () => {
    useNavigationStore.setState({history: ["/home"], historyParams: [undefined]})

    useNavigationStore.getState().clearHistoryAndGoHome({transition: "fade"})

    expect(replace).not.toHaveBeenCalled()
    expect(useNavigationStore.getState().history).toEqual(["/home"])
  })

  it("goes Home from a screen above it", () => {
    useNavigationStore.setState({history: ["/home", "/miniapps/settings"], historyParams: [undefined, undefined]})

    useNavigationStore.getState().clearHistoryAndGoHome()

    expect(replace).toHaveBeenCalledWith({pathname: "/home", params: undefined})
    expect(useNavigationStore.getState().history).toEqual(["/home"])
  })

  it("goes Home when there is no history yet", () => {
    useNavigationStore.getState().clearHistoryAndGoHome({transition: "none"})

    expect(replace).toHaveBeenCalledWith({pathname: "/home", params: {transition: "none"}})
    expect(useNavigationStore.getState().history).toEqual(["/home"])
  })
})
