import {act, fireEvent, render, within} from "@testing-library/react-native"
import i18n from "i18next"
import {Alert, AppState, BackHandler} from "react-native"
import Toast from "react-native-toast-message"

import {ModalProvider} from "@/contexts/ModalContext"
import {FleetSheets, forgetPutOffInvitations, runFleetSheets, showNoticeForFleetState} from "@/effects/FleetSheets"
import en from "@/i18n/en"
import type {FleetManagementState} from "@/services/fleet/fleetManagement"
import {useMyWorkspaceStore} from "@/services/fleet/myWorkspace"
import {
  type InvitationPreview,
  type MyWorkspace,
  setWorkspaceApi,
  type WorkspaceApi,
} from "@/services/fleet/workspaceApi"

/** The engine's Fleet answer. The Jest setup runs the engine's real (pure) module, so tests drive it directly. */
const {resetFleetManagementStateForTests, setFleetManagementState} = jest.requireMock(
  "@mentra/engine-host-internal",
) as {
  resetFleetManagementStateForTests(): void
  setFleetManagementState(state: FleetManagementState): void
}

/** The sheet's drag gesture as last built: whether it's on. */
const mockDrag: {enabled: boolean} = {enabled: false}
jest.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => {
      const builder: Record<string, unknown> = {}
      builder.enabled = (on: boolean) => ((mockDrag.enabled = on), builder)
      for (const name of ["activeOffsetY", "onUpdate", "onEnd"]) builder[name] = () => builder
      return builder
    },
  },
  GestureDetector: ({children}: {children: React.ReactNode}) => children,
}))
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default)
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {
      colors: {secondary_foreground: "#000", border: "#ddd", error: "#d00", success: "#0a0", muted_foreground: "#777"},
      isDark: false,
    },
  }),
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text} = require("react-native")
  return {
    Text: ({text, testID}: {text?: string; testID?: string}) => <Text testID={testID}>{text}</Text>,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </Pressable>
    ),
    Icon: () => null,
  }
})
jest.mock("react-native-toast-message", () => ({__esModule: true, default: {show: jest.fn()}}))
jest.mock("@/utils/storage", () => {
  const values = new Map<string, unknown>()
  return {
    storage: {
      save: (key: string, value: unknown) => values.set(key, value),
      load: (key: string) =>
        values.has(key)
          ? {is_ok: (): boolean => true, value: values.get(key)}
          : {is_ok: (): boolean => false, error: new Error(`No value found for ${key}`)},
      remove: (key: string) => values.delete(key),
      clearAll: () => values.clear(),
    },
  }
})
/** The notice's own MMKV instance, which logout's `storage.clearAll()` does not reach. */
const mockNoticeStore = new Map<string, string>()
jest.mock("react-native-mmkv", () => ({
  createMMKV: () => ({
    getString: (key: string) => mockNoticeStore.get(key),
    set: (key: string, value: string) => mockNoticeStore.set(key, value),
    remove: (key: string) => mockNoticeStore.delete(key),
  }),
}))
let mockUser: {id: string} | null = {id: "user-1"}
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: mockUser})}))

const RIDGELINE: MyWorkspace = {
  workspaceId: "ws-r",
  name: "Ridgeline Field Services",
  role: "member",
  membershipId: "m-1",
}
const NORTHWIND: MyWorkspace = {workspaceId: "ws-n", name: "Northwind Labs", role: "member", membershipId: "m-n"}

const invitation = (workspace: MyWorkspace, extra: Partial<InvitationPreview> = {}): InvitationPreview => ({
  invitationId: `inv-${workspace.workspaceId}`,
  workspaceId: workspace.workspaceId,
  workspaceName: workspace.name,
  email: "maya@example.com",
  role: "member",
  invitedByEmail: null,
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  ...extra,
})

type Calls = string[]

/**
 * An in-memory Core: what `mine` and `invitations` answer follows what accept and leave did. A person may belong to
 * several workspaces: `mine` is the one managing the phone, which a join takes over only from their own automatic
 * workspace or from none.
 */
function fakeCore(start: {mine?: MyWorkspace | null; invitations?: InvitationPreview[]} = {}) {
  const calls: Calls = []
  const state = {mine: start.mine ?? null, invitations: start.invitations ?? [], membership: 1}
  const known = new Map<string, MyWorkspace>()
  const api: WorkspaceApi = {
    mine: jest.fn(async () => {
      calls.push("mine")
      return state.mine
    }),
    invitations: jest.fn(async () => {
      calls.push("invitations")
      return state.invitations
    }),
    accept: jest.fn(async (invitationId: string) => {
      calls.push(`accept:${invitationId}`)
      const source = state.invitations.find((item) => item.invitationId === invitationId)!
      state.invitations = state.invitations.filter((item) => item !== source)
      const workspace: MyWorkspace = {
        workspaceId: source.workspaceId,
        name: source.workspaceName,
        role: "member",
        membershipId: `m-${state.membership++}-${source.workspaceId}`,
      }
      known.set(workspace.workspaceId, workspace)
      if (state.mine === null || state.mine.automatic === true) state.mine = workspace
      return state.mine
    }),
    decline: jest.fn(async (invitationId: string) => {
      calls.push(`decline:${invitationId}`)
      state.invitations = state.invitations.filter((item) => item.invitationId !== invitationId)
    }),
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

const failWith = (code: string, text = "Core says: raw server text") => Object.assign(new Error(text), {code})

/**
 * The sheet's buttons, main action first: top to bottom when stacked, right to left when side by side. The
 * backdrop is a button too, when the sheet can be dismissed, and has no text.
 */
const buttons = (screen: ReturnType<typeof render>) => {
  const labels = screen
    .getAllByRole("button")
    .flatMap((button) => within(button).queryAllByText(/./))
    .map((text) => String(text.props.children))
  return screen.queryByTestId("alert.buttons.row") ? labels.reverse() : labels
}

async function press(screen: ReturnType<typeof render>, label: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(label))
  })
}

/** Starts the sheets and keeps the promise, so a test can finish the run after its sheets close. */
function start(): {done: Promise<void>} {
  let done!: Promise<void>
  act(() => {
    done = runFleetSheets()
  })
  return {done}
}

const finish = ({done}: {done: Promise<void>}) =>
  act(async () => {
    await done
  })

let systemAlert: jest.SpyInstance
let screen: ReturnType<typeof render>

beforeAll(async () => {
  await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
})

beforeEach(() => {
  resetFleetManagementStateForTests()
  mockUser = {id: "user-1"}
  useMyWorkspaceStore.getState().reset()
  forgetPutOffInvitations()
  require("@/utils/storage").storage.clearAll()
  mockNoticeStore.clear()
  ;(Toast.show as jest.Mock).mockClear()
  systemAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
})

afterEach(() => {
  jest.useRealTimers()
  screen?.unmount()
  setWorkspaceApi(null)
  systemAlert.mockRestore()
})

describe("the invitation sheet", () => {
  it("shows the board's words, the can-see and can't-see lists, Join as the main action and Decline after it", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
    for (const text of [
      "If you join, they manage your device and can install miniapps on your phone.",
      "Your workspace can see",
      "Your glasses and phones",
      "Miniapps you use",
      "Your workspace can't see",
      "Your photos and videos",
      "What you say and hear",
      "Your passwords",
    ]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(buttons(screen)).toEqual(["Join", "Decline"])

    await press(screen, "Decline")
    await finish(run)
    expect(systemAlert).not.toHaveBeenCalled()
  })

  it("a swipe, the backdrop or Android back put it off: nothing is declined, and it shows again at the next start", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")

    expect(mockDrag.enabled).toBe(true)
    expect(screen.getByTestId("alert.handle")).toBeTruthy()
    await act(async () => {
      fireEvent.press(screen.getByTestId("alert.backdrop"))
    })
    await finish(run)
    expect(core.api.decline).not.toHaveBeenCalled()
    expect(core.api.accept).not.toHaveBeenCalled()

    // A foreground looks again, and leaves it put off.
    await finish(start())
    expect(screen.queryByText("Ridgeline Field Services invited you to join their workspace")).toBeNull()

    // The next start (or sign-in) offers it again.
    forgetPutOffInvitations()
    const again = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Decline")
    await finish(again)
    expect(core.api.decline).toHaveBeenCalledTimes(1)
  })

  it("declines through Core, and does not list again", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Decline")
    await finish(run)
    expect(core.api.decline).toHaveBeenCalledWith("inv-ws-r")
    expect(core.api.accept).not.toHaveBeenCalled()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()

    const second = start()
    await finish(second)
    expect(screen.queryByText("Ridgeline Field Services invited you to join their workspace")).toBeNull()
  })

  it("shows two invitations in sequence", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE), invitation(NORTHWIND)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    expect(screen.queryByText("Northwind Labs invited you to join their workspace")).toBeNull()
    await press(screen, "Decline")
    expect(await screen.findByText("Northwind Labs invited you to join their workspace")).toBeTruthy()
    expect(screen.queryByText("Ridgeline Field Services invited you to join their workspace")).toBeNull()
    await press(screen, "Decline")
    await finish(run)
    expect(core.api.decline).toHaveBeenCalledTimes(2)
  })

  it("waits for the alert host at startup and never falls back on a system alert", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    const run = start()
    // The invitations are read, but with no host mounted nothing can be shown yet.
    await act(async () => {
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
    expect(core.api.invitations).toHaveBeenCalled()
    expect(systemAlert).not.toHaveBeenCalled()

    screen = render(<ModalProvider>{null}</ModalProvider>)
    expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
    expect(systemAlert).not.toHaveBeenCalled()
    await press(screen, "Decline")
    await finish(run)
    expect(systemAlert).not.toHaveBeenCalled()
  })

  it("closes with a toast, and no API text, when Core says the invitation expired", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    ;(core.api.accept as jest.Mock).mockRejectedValue(
      failWith("invitation_expired", "invitation_expired: raw server text"),
    )
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")
    await finish(run)

    expect(Toast.show).toHaveBeenCalledTimes(1)
    expect(Toast.show).toHaveBeenCalledWith({type: "error", text1: "This invitation has expired."})
    expect(JSON.stringify((Toast.show as jest.Mock).mock.calls)).not.toContain("raw server text")
    expect(screen.queryByText("Ridgeline Field Services invited you to join their workspace")).toBeNull()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()
  })

  it("closes with a toast when the invitation runs out while its sheet is open", async () => {
    // A faked setImmediate (React's act and scheduler flush on it) leaves the next tests hanging on Node 20.
    jest.useFakeTimers({doNotFake: ["setImmediate"]})
    try {
      const core = fakeCore({
        invitations: [invitation(RIDGELINE, {expiresAt: new Date(Date.now() + 30_000).toISOString()})],
      })
      setWorkspaceApi(core.api)
      screen = render(<ModalProvider>{null}</ModalProvider>)
      const run = start()
      expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()

      await act(async () => {
        jest.advanceTimersByTime(30_001)
      })
      await finish(run)
      expect(screen.queryByText("Ridgeline Field Services invited you to join their workspace")).toBeNull()
      expect(Toast.show).toHaveBeenCalledWith({type: "error", text1: "This invitation has expired."})
      expect(core.api.accept).not.toHaveBeenCalled()
      expect(core.api.decline).not.toHaveBeenCalled()
    } finally {
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })

  it("tells a failed join in its own words, keeps the sheet, and lets the person try again", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    ;(core.api.accept as jest.Mock).mockRejectedValueOnce(new Error("socket hang up"))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")
    expect(Toast.show).toHaveBeenCalledWith({type: "error", text1: "Something went wrong. Try again."})
    expect(JSON.stringify((Toast.show as jest.Mock).mock.calls)).not.toContain("socket hang up")
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")

    await press(screen, "Join")
    await finish(run)
    expect(core.api.accept).toHaveBeenCalledTimes(2)
  })
})

describe("an invitation while in a workspace", () => {
  const KEPT =
    "You'll stay in Northwind Labs, which keeps managing this phone. Ridgeline Field Services won't see it while Northwind Labs does."

  it("while a real workspace manages the phone: Join, no leave, and that workspace keeps the phone", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    expect(screen.getByText(KEPT)).toBeTruthy()
    // It won't manage the phone, so it says nothing of what it would see.
    expect(screen.queryByTestId("fleet.seeLists")).toBeNull()
    expect(
      screen.queryByText("If you join, they manage your device and can install miniapps on your phone."),
    ).toBeNull()
    expect(buttons(screen)).toEqual(["Join", "Decline"])
    expect(mockDrag.enabled).toBe(true)

    await press(screen, "Join")
    await finish(run)
    expect(core.api.leave).not.toHaveBeenCalled()
    expect(core.calls).toContain(`accept:${invitation(RIDGELINE).invitationId}`)
    // The phone stays with Northwind: no notice comes, so a toast says the join worked.
    expect(useMyWorkspaceStore.getState().workspace).toEqual(NORTHWIND)
    expect(Toast.show).toHaveBeenCalledWith({type: "success", text1: "You joined Ridgeline Field Services."})
  })

  it("while the person's own automatic workspace manages the phone: the usual terms, and the workspace joined takes it", async () => {
    const own: MyWorkspace = {...NORTHWIND, name: "Maya's Workspace", automatic: true}
    const core = fakeCore({mine: own, invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    expect(
      screen.getByText("If you join, they manage your device and can install miniapps on your phone."),
    ).toBeTruthy()
    expect(screen.getByTestId("fleet.seeLists")).toBeTruthy()
    expect(buttons(screen)).toEqual(["Join", "Decline"])

    await press(screen, "Join")
    await finish(run)
    expect(core.api.leave).not.toHaveBeenCalled()
    expect(useMyWorkspaceStore.getState().workspace?.workspaceId).toBe(RIDGELINE.workspaceId)
    // The Fleet notice says it, once Fleet answers: no toast as well.
    expect(core.calls).toContain("refreshDesiredState")
    expect(Toast.show).not.toHaveBeenCalled()
  })

  it("against an older Core that refuses the join, leaves first through the confirm, then joins", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    ;(core.api.accept as jest.Mock).mockRejectedValueOnce(failWith("already_in_workspace"))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")
    expect(await screen.findByText("Leave Northwind Labs?")).toBeTruthy()
    expect(buttons(screen)).toEqual(["Leave", "Cancel"])
    await press(screen, "Leave")
    // It leaves the workspace the confirm named, then offers the invitation again.
    expect(core.api.leave).toHaveBeenCalledWith(NORTHWIND.workspaceId)
    expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
    await press(screen, "Join")
    await finish(run)
    expect(core.api.accept).toHaveBeenCalledTimes(2)
    expect(useMyWorkspaceStore.getState().workspace?.workspaceId).toBe(RIDGELINE.workspaceId)
  })

  it("against an older Core, shows the last-Owner copy when the leave is refused, and comes back to the invitation", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    ;(core.api.accept as jest.Mock).mockRejectedValue(failWith("already_in_workspace"))
    ;(core.api.leave as jest.Mock).mockRejectedValue(failWith("last_owner"))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")
    await screen.findByText("Leave Northwind Labs?")
    await press(screen, "Leave")
    expect(
      await screen.findByText(
        "You're this workspace's only Owner. Hand over ownership or delete the workspace in Mentra Portal first.",
      ),
    ).toBeTruthy()
    await press(screen, "OK")
    expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
    await press(screen, "Decline")
    await finish(run)
  })

  it("looks again instead of offering the wrong terms when the workspace read was dropped for a session change", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    ;(core.api.mine as jest.Mock).mockRejectedValueOnce(failWith("session_changed"))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    expect(await screen.findByText(KEPT)).toBeTruthy()
    expect(core.api.mine).toHaveBeenCalledTimes(2)
    await press(screen, "Decline")
    await finish(run)
  })

  it("stops looking at once when the session keeps changing under the reads, and looks again on the next run", async () => {
    const core = fakeCore({mine: null, invitations: []})
    ;(core.api.mine as jest.Mock).mockRejectedValue(failWith("session_changed"))
    setWorkspaceApi(core.api)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    await finish(start())
    // The first look and two more, not a loop.
    expect(core.api.mine).toHaveBeenCalledTimes(3)
    await finish(start())
    expect(core.api.mine).toHaveBeenCalledTimes(6)
    warn.mockRestore()
  })
})

describe("the Fleet notice", () => {
  const RIDGELINE_MANAGED = {
    status: "managed",
    workspaceId: "ws-r",
    workspaceName: "Ridgeline Field Services",
  } as const
  const NORTHWIND_MANAGED = {status: "managed", workspaceId: "ws-n", workspaceName: "Northwind Labs"} as const
  const NOTICE = "You've now joined the Ridgeline Field Services workspace"

  /** The Mentra App with the Fleet sheets running, as it is at startup. */
  const renderApp = async () => {
    screen = render(
      <ModalProvider>
        <FleetSheets />
      </ModalProvider>,
    )
    await act(async () => {
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
  }
  const hearFleet = (state: FleetManagementState) =>
    act(async () => {
      setFleetManagementState(state)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })

  it("confirms the join in the board's words with OK only, and no handle", async () => {
    setWorkspaceApi(fakeCore().api)
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)

    expect(screen.getByText(NOTICE)).toBeTruthy()
    expect(
      screen.getByText("By joining the Ridgeline Field Services workspace, you agree to let them manage your device."),
    ).toBeTruthy()
    expect(screen.getByText("Mentra Fleet Management")).toBeTruthy()
    expect(screen.getByText("Managed by your workspace's admins")).toBeTruthy()
    // The lists moved to the invitation: the notice is only the confirmation.
    expect(screen.queryByText("Your workspace can see")).toBeNull()
    expect(buttons(screen)).toEqual(["OK"])
    expect(screen.queryByTestId("alert.handle")).toBeNull()
    expect(mockDrag.enabled).toBe(false)

    await press(screen, "OK")
    expect(screen.queryByText(NOTICE)).toBeNull()
    expect(systemAlert).not.toHaveBeenCalled()
  })

  it("resists the swipe, the backdrop and Android back", async () => {
    const listeners: Array<() => boolean | null | undefined> = []
    const addListener = jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      listeners.push(listener)
      return {remove: () => listeners.splice(listeners.indexOf(listener), 1)}
    })
    try {
      setWorkspaceApi(fakeCore().api)
      await renderApp()
      await hearFleet(RIDGELINE_MANAGED)

      expect(mockDrag.enabled).toBe(false)
      await act(async () => {
        fireEvent.press(screen.getByTestId("alert.backdrop", {includeHiddenElements: true}))
      })
      let handled: boolean | null | undefined
      await act(async () => {
        handled = listeners[listeners.length - 1]?.()
      })
      expect(handled).toBe(true)
      expect(screen.getByText(NOTICE)).toBeTruthy()

      await press(screen, "OK")
      expect(screen.queryByText(NOTICE)).toBeNull()
    } finally {
      addListener.mockRestore()
    }
  })

  it("never shows while Fleet's state is unknown or unmanaged", async () => {
    setWorkspaceApi(fakeCore({mine: RIDGELINE}).api)
    await renderApp()
    expect(screen.queryByText(NOTICE)).toBeNull()

    await hearFleet({status: "unmanaged"})
    expect(screen.queryByText(NOTICE)).toBeNull()
    await hearFleet({status: "unknown"})
    expect(screen.queryByText(NOTICE)).toBeNull()
    // Being in a workspace is not being managed: Core without Fleet never answers `managed`.
    expect(useMyWorkspaceStore.getState().workspace?.name).toBe("Ridgeline Field Services")
    expect(screen.queryByText("OK")).toBeNull()
  })

  it("waits for Fleet's answer after a join, starting the fetch at once and never blocking on it", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    ;(core.api.refreshDesiredState as jest.Mock).mockImplementation(() => {
      core.calls.push("refreshDesiredState")
      return new Promise(() => {})
    })
    setWorkspaceApi(core.api)
    await renderApp()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")

    expect(core.calls.indexOf("accept:inv-ws-r")).toBeLessThan(core.calls.indexOf("refreshDesiredState"))
    expect(screen.queryByText(NOTICE)).toBeNull()

    await hearFleet(RIDGELINE_MANAGED)
    expect(screen.getByText(NOTICE)).toBeTruthy()
    await press(screen, "OK")
  })

  it("does not stop for a failed desired-state fetch: the notice comes with the next answer", async () => {
    const core = fakeCore({invitations: [invitation(NORTHWIND)]})
    ;(core.api.refreshDesiredState as jest.Mock).mockRejectedValue(new Error("503"))
    setWorkspaceApi(core.api)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await renderApp()
      await screen.findByText("Northwind Labs invited you to join their workspace")
      await press(screen, "Join")
      expect(screen.queryByText("You've now joined the Northwind Labs workspace")).toBeNull()
      await hearFleet(NORTHWIND_MANAGED)
      expect(screen.getByText("You've now joined the Northwind Labs workspace")).toBeTruthy()
      await press(screen, "OK")
    } finally {
      warn.mockRestore()
    }
  })

  it("shows for a workspace joined elsewhere (the portal) once the phone is already managed at startup", async () => {
    setFleetManagementState(RIDGELINE_MANAGED)
    setWorkspaceApi(fakeCore({mine: RIDGELINE, invitations: [invitation(NORTHWIND)]}).api)
    await renderApp()
    expect(screen.getByText(NOTICE)).toBeTruthy()
    await press(screen, "OK")
    // The invitation waits its turn behind the notice, then shows.
    expect(await screen.findByText("Northwind Labs invited you to join their workspace")).toBeTruthy()
    await press(screen, "Decline")
  })

  it("shows once per workspace: not on a restart, a foreground, a renamed workspace or a repeated answer", async () => {
    setWorkspaceApi(fakeCore({mine: RIDGELINE}).api)
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    await press(screen, "OK")

    await hearFleet({...RIDGELINE_MANAGED, workspaceName: "Ridgeline Field Services Inc"})
    expect(screen.queryByText("OK")).toBeNull()
    // The answer is lost (signed out) and comes back: still the same workspace.
    await hearFleet({status: "unknown"})
    await hearFleet(RIDGELINE_MANAGED)
    expect(screen.queryByText("OK")).toBeNull()

    // A restart: nothing in memory, the phone is managed from its stored answer.
    screen.unmount()
    await renderApp()
    await act(async () => {
      await showNoticeForFleetState("user-1", RIDGELINE_MANAGED)
    })
    expect(screen.queryByText("OK")).toBeNull()
  })

  it("is not shown again after signing out and in, and shows for another account on the phone", async () => {
    setWorkspaceApi(fakeCore({mine: RIDGELINE}).api)
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    await press(screen, "OK")
    screen.unmount()

    // Logout clears the default storage, and the engine forgets its answer until the next sign-in.
    require("@/utils/storage").storage.clearAll()
    mockUser = null
    await renderApp()
    await hearFleet({status: "unknown"})
    screen.unmount()
    mockUser = {id: "user-1"}
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    expect(screen.queryByText("OK")).toBeNull()
    screen.unmount()

    await hearFleet({status: "unknown"})
    mockUser = {id: "user-2"}
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    expect(screen.getByText(NOTICE)).toBeTruthy()
    await press(screen, "OK")
  })

  it("does not queue the notice twice when Fleet's answer is heard twice at once", async () => {
    setWorkspaceApi(fakeCore().api)
    await renderApp()
    await act(async () => {
      void showNoticeForFleetState("user-1", RIDGELINE_MANAGED)
      void showNoticeForFleetState("user-1", RIDGELINE_MANAGED)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
    await press(screen, "OK")
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it("shows again after Fleet says unmanaged and the person is managed again", async () => {
    setWorkspaceApi(fakeCore().api)
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    await press(screen, "OK")

    await hearFleet({status: "unmanaged"})
    await hearFleet(RIDGELINE_MANAGED)
    expect(screen.getByText(NOTICE)).toBeTruthy()
    await press(screen, "OK")
  })

  it("shows for a different workspace the person moves to", async () => {
    setWorkspaceApi(fakeCore().api)
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    await press(screen, "OK")

    await hearFleet(NORTHWIND_MANAGED)
    expect(screen.getByText("You've now joined the Northwind Labs workspace")).toBeTruthy()
    await press(screen, "OK")
  })

  it("is the same on a stored answer after a restart, and is not shown again", async () => {
    setWorkspaceApi(fakeCore().api)
    await renderApp()
    await hearFleet(RIDGELINE_MANAGED)
    await press(screen, "OK")
    screen.unmount()

    // The engine restores its stored `managed` answer before the sheets mount.
    setFleetManagementState({status: "unknown"})
    setFleetManagementState(RIDGELINE_MANAGED)
    await renderApp()
    expect(screen.queryByText("OK")).toBeNull()
  })
})

describe("when the sheets run", () => {
  it("does nothing, and throws nothing, while the real client is not wired", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      screen = render(<ModalProvider>{null}</ModalProvider>)
      await finish(start())
      expect(warn).toHaveBeenCalled()
      expect(systemAlert).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("looks at startup and on foreground while signed in, and not when signed out", async () => {
    let appStateListener: ((state: string) => void) | undefined
    const subscription = {remove: jest.fn()}
    const addListener = jest.spyOn(AppState, "addEventListener").mockImplementation(((
      _type: string,
      listener: never,
    ) => {
      appStateListener = listener
      return subscription
    }) as never)
    try {
      const core = fakeCore()
      setWorkspaceApi(core.api)
      const view = render(
        <ModalProvider>
          <FleetSheets />
        </ModalProvider>,
      )
      screen = view
      await act(async () => {
        for (let tick = 0; tick < 20; tick++) await Promise.resolve()
      })
      expect(core.api.invitations).toHaveBeenCalledTimes(1)

      await act(async () => {
        appStateListener?.("background")
        appStateListener?.("active")
        for (let tick = 0; tick < 20; tick++) await Promise.resolve()
      })
      expect(core.api.invitations).toHaveBeenCalledTimes(2)

      mockUser = null
      view.rerender(
        <ModalProvider>
          <FleetSheets />
        </ModalProvider>,
      )
      expect(subscription.remove).toHaveBeenCalled()
      expect(useMyWorkspaceStore.getState().loaded).toBe(false)
    } finally {
      addListener.mockRestore()
    }
  })

  it("looks again once the real client is wired after sign-in, without waiting for a foreground", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const addListener = jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((() => ({remove: jest.fn()})) as never)
    try {
      screen = render(
        <ModalProvider>
          <FleetSheets />
        </ModalProvider>,
      )
      await act(async () => {
        for (let tick = 0; tick < 20; tick++) await Promise.resolve()
      })
      expect(screen.queryByText("Ridgeline Field Services invited you to join their workspace")).toBeNull()

      const core = fakeCore({invitations: [invitation(RIDGELINE)]})
      act(() => setWorkspaceApi(core.api))
      expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
      await press(screen, "Decline")
    } finally {
      addListener.mockRestore()
      warn.mockRestore()
    }
  })

  it("folds foreground events during open sheets into one more look, without stacking sheets", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    act(() => {
      void runFleetSheets()
      void runFleetSheets()
    })
    expect(screen.getAllByText("Ridgeline Field Services invited you to join their workspace")).toHaveLength(1)
    await press(screen, "Decline")
    await finish(run)
    expect(core.api.invitations).toHaveBeenCalledTimes(2)
  })
})
