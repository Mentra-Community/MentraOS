import {act, fireEvent, render, within} from "@testing-library/react-native"
import i18n from "i18next"
import {Alert, AppState, BackHandler} from "react-native"
import Toast from "react-native-toast-message"

import {ModalProvider} from "@/contexts/ModalContext"
import {FleetSheets, runFleetSheets, showNoticeForFleetState} from "@/effects/FleetSheets"
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

/** An in-memory Core: what `mine` and `invitations` answer follows what accept and leave did. */
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
      state.mine = workspace
      return workspace
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
  require("@/utils/storage").storage.clearAll()
  ;(Toast.show as jest.Mock).mockClear()
  systemAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
})

afterEach(() => {
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
    expect(screen.queryByTestId("fleet.leaveFirstRule")).toBeNull()

    await press(screen, "Decline")
    await finish(run)
    expect(systemAlert).not.toHaveBeenCalled()
  })

  it("is not swipeable: the drag, the backdrop and Android back leave it open, and it has no handle", async () => {
    const listeners: Array<() => boolean | null | undefined> = []
    const addListener = jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      listeners.push(listener)
      return {remove: () => listeners.splice(listeners.indexOf(listener), 1)}
    })
    try {
      const core = fakeCore({invitations: [invitation(RIDGELINE)]})
      setWorkspaceApi(core.api)
      screen = render(<ModalProvider>{null}</ModalProvider>)
      const run = start()
      await screen.findByText("Ridgeline Field Services invited you to join their workspace")

      expect(mockDrag.enabled).toBe(false)
      expect(screen.queryByTestId("alert.handle")).toBeNull()
      await act(async () => {
        fireEvent.press(screen.getByTestId("alert.backdrop", {includeHiddenElements: true}))
      })
      let handled: boolean | null | undefined
      await act(async () => {
        handled = listeners[listeners.length - 1]?.()
      })
      expect(handled).toBe(true)
      expect(screen.getByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
      expect(core.api.decline).not.toHaveBeenCalled()

      await press(screen, "Decline")
      await finish(run)
    } finally {
      addListener.mockRestore()
    }
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
    jest.useFakeTimers()
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

describe("the leave-first variant", () => {
  it("names the current workspace, makes Leave the main action, and goes Leave -> confirm -> Join", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    expect(screen.getByText("You're in Northwind Labs. Leave it to join Ridgeline Field Services.")).toBeTruthy()
    expect(buttons(screen)).toEqual(["Leave Northwind Labs", "Decline"])
    expect(mockDrag.enabled).toBe(false)

    await press(screen, "Leave Northwind Labs")
    expect(await screen.findByText("Leave Northwind Labs?")).toBeTruthy()
    expect(screen.getByText("Its miniapps come off this phone.")).toBeTruthy()
    expect(buttons(screen)).toEqual(["Leave", "Cancel"])
    // The leave confirm can be cancelled, so it has the handle and can be swiped.
    expect(screen.queryByTestId("alert.handle")).not.toBeNull()
    expect(mockDrag.enabled).toBe(true)

    await press(screen, "Leave")
    // Core is called, then the desired state is fetched at once, then Join is offered.
    expect(await screen.findByText("Join")).toBeTruthy()
    expect(core.calls.filter((call) => call === "leave" || call === "refreshDesiredState")).toEqual([
      "leave",
      "refreshDesiredState",
    ])
    expect(screen.queryByTestId("fleet.leaveFirstRule")).toBeNull()
    expect(buttons(screen)).toEqual(["Join", "Decline"])

    await press(screen, "Decline")
    await finish(run)
  })

  it("comes back to the invitation when the leave confirm is cancelled", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Leave Northwind Labs")
    await screen.findByText("Leave Northwind Labs?")
    await press(screen, "Cancel")
    expect(await screen.findByText("Ridgeline Field Services invited you to join their workspace")).toBeTruthy()
    expect(core.api.leave).not.toHaveBeenCalled()
    await press(screen, "Decline")
    await finish(run)
  })

  it("shows the last-Owner copy when Core refuses the leave with last_owner", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    ;(core.api.leave as jest.Mock).mockRejectedValue(failWith("last_owner"))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Leave Northwind Labs")
    await screen.findByText("Leave Northwind Labs?")
    await press(screen, "Leave")

    expect(
      await screen.findByText(
        "You're this workspace's only Owner. Hand over ownership or delete the workspace in Mentra Portal first.",
      ),
    ).toBeTruthy()
    expect(core.api.refreshDesiredState).not.toHaveBeenCalled()
    await press(screen, "OK")
    // Back to the invitation, still asking to leave first.
    expect(await screen.findByText("Leave Northwind Labs")).toBeTruthy()
    await press(screen, "Decline")
    await finish(run)
  })

  it("looks again instead of offering a plain Join when the workspace read was dropped for a session change", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    ;(core.api.mine as jest.Mock).mockRejectedValueOnce(failWith("session_changed"))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()

    expect(await screen.findByText("Leave Northwind Labs")).toBeTruthy()
    expect(screen.queryByText("Join")).toBeNull()
    expect(core.api.mine).toHaveBeenCalledTimes(2)
    await press(screen, "Decline")
    await finish(run)
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
      await showNoticeForFleetState(RIDGELINE_MANAGED)
    })
    expect(screen.queryByText("OK")).toBeNull()
  })

  it("does not queue the notice twice when Fleet's answer is heard twice at once", async () => {
    setWorkspaceApi(fakeCore().api)
    await renderApp()
    await act(async () => {
      void showNoticeForFleetState(RIDGELINE_MANAGED)
      void showNoticeForFleetState(RIDGELINE_MANAGED)
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
