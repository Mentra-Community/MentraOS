import {act, fireEvent, render, screen} from "@testing-library/react-native"
import {useRef} from "react"
import {BackHandler} from "react-native"

import {beginMiniappLinkOpen, cancelMiniappLinkOpens, useMiniappLinkOpenStore} from "@/stores/miniappLinkOpen"

import {MiniappLinkOpen} from "./MiniappLinkOpen"

jest.mock("@/components/miniapp/MiniappSplash", () => {
  const {Text} = require("react-native")
  return function MockMiniappSplash({name, label, iconUrl}: {name?: string; label?: string; iconUrl?: string}) {
    return <Text testID="splash">{[name, iconUrl, label].filter(Boolean).join(" | ")}</Text>
  }
})
jest.mock("@/components/ignite", () => ({Icon: () => null}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({top: 0, bottom: 0})}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {background: "white", text: "black"}}}),
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))

// The real shared value needs the UI runtime; a ref holds the same value here.
function useMockSharedValue(initial: unknown) {
  return useRef({value: initial}).current
}
require("react-native-reanimated").useSharedValue = useMockSharedValue

afterEach(() => cancelMiniappLinkOpens())

test("shows nothing until a link is opened", () => {
  render(<MiniappLinkOpen />)
  expect(screen.queryByTestId("miniapp-link-open")).toBeNull()
})

test("says a miniapp is opening, then shows the miniapp while it installs, then closes", () => {
  render(<MiniappLinkOpen />)
  let opening!: ReturnType<typeof beginMiniappLinkOpen>
  act(() => {
    opening = beginMiniappLinkOpen()
  })
  expect(screen.getByTestId("splash").props.children).toBe("miniappInstall:opening")

  act(() => opening.show({name: "Notes", iconUrl: "https://notes.example.com/icon.png"}))
  expect(screen.getByTestId("splash").props.children).toBe(
    "Notes | https://notes.example.com/icon.png | home:miniappInstalling",
  )

  act(() => opening.end())
  expect(screen.queryByTestId("miniapp-link-open")).toBeNull()
})

test("its close button stops the link", () => {
  render(<MiniappLinkOpen />)
  let opening!: ReturnType<typeof beginMiniappLinkOpen>
  act(() => {
    opening = beginMiniappLinkOpen()
  })
  fireEvent.press(screen.getByTestId("miniapp-link-open.close"))
  expect(opening.cancelled).toBe(true)
  expect(useMiniappLinkOpenStore.getState().view).toBeNull()
  expect(screen.queryByTestId("miniapp-link-open")).toBeNull()
})

test("Android back stops the link, and goes nowhere else", () => {
  const listeners: Array<() => boolean | null | undefined> = []
  const remove = jest.fn()
  const add = jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
    listeners.push(listener)
    return {remove}
  })
  render(<MiniappLinkOpen />)
  let opening!: ReturnType<typeof beginMiniappLinkOpen>
  act(() => {
    opening = beginMiniappLinkOpen()
  })
  let handled: boolean | null | undefined
  act(() => {
    handled = listeners.at(-1)?.()
  })
  expect(handled).toBe(true)
  expect(opening.cancelled).toBe(true)
  expect(remove).toHaveBeenCalled()
  add.mockRestore()
})
