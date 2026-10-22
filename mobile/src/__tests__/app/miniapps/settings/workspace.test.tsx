import {act, fireEvent, render} from "@testing-library/react-native"
import i18n from "i18next"
import Toast from "react-native-toast-message"

import MainSettingsPage from "@/app/miniapps/settings/main"
import WorkspaceScreen from "@/app/miniapps/settings/workspace"
import {ModalProvider} from "@/contexts/ModalContext"
import en from "@/i18n/en"
import {useMyWorkspaceStore} from "@/services/fleet/myWorkspace"
import {type MyWorkspace, setWorkspaceApi, type WorkspaceApi} from "@/services/fleet/workspaceApi"

const mockNav = {goBack: jest.fn(), push: jest.fn()}
/** The effects the screens run on focus: calling them again is the person coming back to the screen. */
const mockFocusEffects = new Set<() => void>()

jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => void) => {
    const {useEffect} = require("react")
    useEffect(() => {
      mockFocusEffects.add(effect)
      effect()
      return () => void mockFocusEffects.delete(effect)
    }, [effect])
  },
}))
jest.mock("react-native-gesture-handler", () => {
  const builder: Record<string, unknown> = {}
  for (const name of ["enabled", "activeOffsetY", "onUpdate", "onEnd"]) builder[name] = () => builder
  return {
    Gesture: {Pan: () => builder},
    GestureDetector: ({children}: {children: React.ReactNode}) => children,
    ScrollView: require("react-native").ScrollView,
  }
})
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default)
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => {
    const theme = {
      colors: {secondary_foreground: "#000", border: "#ddd", error: "#d00", success: "#0a0", muted_foreground: "#777"},
      spacing: require("@/theme/spacing").spacing,
      isDark: false,
    }
    return {theme, themed: (style: (value: typeof theme) => unknown) => style(theme)}
  },
}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: {id: "user-1"}})}))
jest.mock("@/services/deployment", () => ({useDeployment: () => ({activeDeployment: {kind: "consumer"}})}))
jest.mock("@/services/deployment/miniappDevelopmentPolicy", () => ({isMiniappDevelopmentAllowed: () => false}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => mockNav}}))
jest.mock("@/stores/capsule", () => ({useCapsuleStore: {}, useRegisterCapsule: jest.fn()}))
jest.mock("@/i18n", () => ({
  translate: (...args: unknown[]) => require("@/i18n/translate").translate(...args),
}))
jest.mock("@/components/settings/DeviceSettingsSection", () => ({DeviceSettingsSection: () => null}))
jest.mock("@/components/dev/VersionInfo", () => ({VersionInfo: () => null}))
jest.mock("@/components/ui/Spacer", () => ({Spacer: () => null}))
jest.mock("@mentra/engine", () => ({
  SETTINGS: {
    debug_mode: {key: "debug_mode"},
    super_mode: {key: "super_mode"},
    appearance_menu_enabled: {key: "appearance_menu_enabled"},
  },
  useSetting: () => [false],
}))
jest.mock("react-native-toast-message", () => ({__esModule: true, default: {show: jest.fn()}}))
jest.mock("@/utils/storage", () => {
  const values = new Map<string, unknown>()
  return {
    storage: {
      save: (key: string, value: unknown) => values.set(key, value),
      load: (key: string) =>
        values.has(key)
          ? {is_ok: (): boolean => true, value: values.get(key)}
          : {is_ok: (): boolean => false, error: new Error(key)},
      remove: (key: string) => values.delete(key),
    },
  }
})
jest.mock("@/components/ui/RouteButton", () => {
  const {Pressable, Text} = require("react-native")
  return {
    RouteButton: ({label, subtitle, onPress}: {label: string; subtitle?: string; onPress?: () => void}) => (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
        <Text>{label}</Text>
        {subtitle && <Text testID="route.subtitle">{subtitle}</Text>}
      </Pressable>
    ),
  }
})
jest.mock("@/components/ignite", () => {
  const {Pressable, Text, View} = require("react-native")
  return {
    Screen: View,
    Header: ({title}: {title: string}) => <Text accessibilityRole="header">{title}</Text>,
    Icon: () => null,
    Text: ({text, children, testID}: {text?: string; children?: React.ReactNode; testID?: string}) => (
      <Text testID={testID}>{text ?? children}</Text>
    ),
    Button: ({
      text,
      onPress,
      disabled,
      testID,
    }: {
      text: string
      onPress: () => void
      disabled?: boolean
      testID?: string
    }) => (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} testID={testID}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

const RIDGELINE: MyWorkspace = {
  workspaceId: "ws-r",
  name: "Ridgeline Field Services",
  role: "member",
  membershipId: "m-1",
}

function fakeCore(initial: MyWorkspace | null) {
  const calls: string[] = []
  const state = {mine: initial}
  const api: WorkspaceApi = {
    mine: jest.fn(async () => {
      calls.push("mine")
      return state.mine
    }),
    invitations: jest.fn(async () => []),
    accept: jest.fn(),
    decline: jest.fn(),
    leave: jest.fn(async () => {
      calls.push("leave")
      state.mine = null
    }),
    refreshDesiredState: jest.fn(async () => {
      calls.push("refreshDesiredState")
    }),
  }
  return {api, calls, state}
}

const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 20; tick++) await Promise.resolve()
  })
const refocus = () =>
  act(async () => {
    mockFocusEffects.forEach((effect) => effect())
    for (let tick = 0; tick < 20; tick++) await Promise.resolve()
  })

beforeAll(async () => {
  await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
})

beforeEach(() => {
  mockNav.goBack.mockClear()
  mockNav.push.mockClear()
  mockFocusEffects.clear()
  useMyWorkspaceStore.getState().reset()
  ;(Toast.show as jest.Mock).mockClear()
})

afterEach(() => setWorkspaceApi(null))

describe("Settings: the Workspace row", () => {
  it("shows the workspace name with the role below, under Workspace", async () => {
    setWorkspaceApi(fakeCore(RIDGELINE).api)
    const screen = render(<MainSettingsPage />)
    await settle()

    expect(screen.getByText("Workspace")).toBeTruthy()
    expect(screen.getByText("Ridgeline Field Services")).toBeTruthy()
    expect(screen.getByTestId("route.subtitle").props.children).toBe("Member")
    // One workspace row: the separate "Mentra Fleet Management" row is gone.
    expect(screen.queryByText("Mentra Fleet Management")).toBeNull()
  })

  it("opens the workspace page", async () => {
    setWorkspaceApi(fakeCore(RIDGELINE).api)
    const screen = render(<MainSettingsPage />)
    await settle()
    fireEvent.press(screen.getByLabelText("Ridgeline Field Services"))
    expect(mockNav.push).toHaveBeenCalledWith("/miniapps/settings/workspace")
  })

  it("is hidden when there is no workspace", async () => {
    setWorkspaceApi(fakeCore(null).api)
    const screen = render(<MainSettingsPage />)
    await settle()
    expect(screen.queryByText("Workspace")).toBeNull()
    expect(screen.queryByTestId("route.subtitle")).toBeNull()
  })

  it("keeps the last answer when Core cannot be reached, instead of hiding the row", async () => {
    const core = fakeCore(RIDGELINE)
    setWorkspaceApi(core.api)
    const screen = render(<MainSettingsPage />)
    await settle()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      ;(core.api.mine as jest.Mock).mockRejectedValue(new Error("offline"))
      await refocus()
      expect(screen.getByText("Ridgeline Field Services")).toBeTruthy()
    } finally {
      warn.mockRestore()
    }
  })

  it("reads the role again when the page gains focus", async () => {
    const core = fakeCore(RIDGELINE)
    setWorkspaceApi(core.api)
    const screen = render(<MainSettingsPage />)
    await settle()
    expect(screen.getByTestId("route.subtitle").props.children).toBe("Member")

    core.state.mine = {...RIDGELINE, role: "admin"}
    await refocus()
    expect(screen.getByTestId("route.subtitle").props.children).toBe("Admin")
    expect(core.api.mine).toHaveBeenCalledTimes(2)
  })
})

describe("Settings: the workspace page", () => {
  const renderPage = () =>
    render(
      <ModalProvider>
        <WorkspaceScreen />
      </ModalProvider>,
    )

  it("shows the board's words: the name and role, who manages, both lists and Leave workspace", async () => {
    setWorkspaceApi(fakeCore(RIDGELINE).api)
    const screen = renderPage()
    await settle()

    expect(screen.getByRole("header").props.children).toBe("Workspace")
    expect(screen.getByText("Ridgeline Field Services")).toBeTruthy()
    expect(screen.getByTestId("workspace.role").props.children).toBe("Member")
    expect(screen.getByText("Mentra Fleet Management")).toBeTruthy()
    expect(screen.getByText("Managed by your workspace's admins")).toBeTruthy()
    for (const text of [
      "Your workspace can see",
      "Your glasses and phones",
      "Miniapps you use",
      "Your workspace can't see",
      "Your photos and videos",
      "What you say and hear",
      "Your passwords",
      "Leave workspace",
    ]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
  })

  it("leaves through the confirm, then Core, then at once the desired state", async () => {
    const core = fakeCore(RIDGELINE)
    setWorkspaceApi(core.api)
    const screen = renderPage()
    await settle()

    await act(async () => {
      fireEvent.press(screen.getByTestId("workspace.leave"))
    })
    expect(await screen.findByText("Leave Ridgeline Field Services?")).toBeTruthy()
    expect(screen.getByText("Its miniapps come off this phone.")).toBeTruthy()
    // Nothing is called until the person confirms.
    expect(core.api.leave).not.toHaveBeenCalled()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.press(screen.getByText("Leave"))
    })
    await settle()
    expect(core.calls.filter((call) => call !== "mine")).toEqual(["leave", "refreshDesiredState"])
    // The workspace is gone, so the page is too.
    expect(mockNav.goBack).toHaveBeenCalled()
    expect(screen.queryByText("Leave workspace")).toBeNull()
    expect(useMyWorkspaceStore.getState().workspace).toBeNull()
  })

  it("leaves nothing changed when the confirm is cancelled", async () => {
    const core = fakeCore(RIDGELINE)
    setWorkspaceApi(core.api)
    const screen = renderPage()
    await settle()
    await act(async () => {
      fireEvent.press(screen.getByTestId("workspace.leave"))
    })
    await screen.findByText("Leave Ridgeline Field Services?")
    await act(async () => {
      fireEvent.press(screen.getByText("Cancel"))
    })
    await settle()
    expect(core.api.leave).not.toHaveBeenCalled()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()
    expect(mockNav.goBack).not.toHaveBeenCalled()
    expect(screen.getByText("Leave workspace")).toBeTruthy()
  })

  it("replaces Leave with the last-Owner copy when Core answers last_owner", async () => {
    const core = fakeCore({...RIDGELINE, role: "owner"})
    ;(core.api.leave as jest.Mock).mockRejectedValue(Object.assign(new Error("raw server text"), {code: "last_owner"}))
    setWorkspaceApi(core.api)
    const screen = renderPage()
    await settle()
    expect(screen.getByTestId("workspace.role").props.children).toBe("Owner")

    await act(async () => {
      fireEvent.press(screen.getByTestId("workspace.leave"))
    })
    await screen.findByText("Leave Ridgeline Field Services?")
    await act(async () => {
      fireEvent.press(screen.getByText("Leave"))
    })
    await settle()

    expect(screen.getByTestId("workspace.lastOwner").props.children).toBe(
      "You're this workspace's only Owner. Hand over ownership or delete the workspace in Mentra Portal first.",
    )
    expect(screen.queryByText("Leave workspace")).toBeNull()
    expect(screen.queryByText("raw server text")).toBeNull()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()
    expect(mockNav.goBack).not.toHaveBeenCalled()
    expect(Toast.show).not.toHaveBeenCalled()
  })

  it("says something went wrong, in its own words, when the leave fails otherwise", async () => {
    const core = fakeCore(RIDGELINE)
    ;(core.api.leave as jest.Mock).mockRejectedValue(new Error("socket hang up"))
    setWorkspaceApi(core.api)
    const screen = renderPage()
    await settle()
    await act(async () => {
      fireEvent.press(screen.getByTestId("workspace.leave"))
    })
    await screen.findByText("Leave Ridgeline Field Services?")
    await act(async () => {
      fireEvent.press(screen.getByText("Leave"))
    })
    await settle()
    expect(Toast.show).toHaveBeenCalledWith({type: "error", text1: "Something went wrong. Try again."})
    expect(JSON.stringify((Toast.show as jest.Mock).mock.calls)).not.toContain("socket hang up")
    expect(screen.getByText("Leave workspace")).toBeTruthy()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()
  })

  it("is hidden when there is no workspace", async () => {
    setWorkspaceApi(fakeCore(null).api)
    const screen = renderPage()
    await settle()
    expect(screen.queryByText("Leave workspace")).toBeNull()
    expect(screen.queryByText("Mentra Fleet Management")).toBeNull()
    expect(mockNav.goBack).toHaveBeenCalled()
  })

  it("reads the role again when the page gains focus", async () => {
    const core = fakeCore(RIDGELINE)
    setWorkspaceApi(core.api)
    const screen = renderPage()
    await settle()
    expect(screen.getByTestId("workspace.role").props.children).toBe("Member")

    core.state.mine = {...RIDGELINE, role: "owner"}
    await refocus()
    expect(screen.getByTestId("workspace.role").props.children).toBe("Owner")
  })
})
