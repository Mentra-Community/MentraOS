import {act, fireEvent, render, within} from "@testing-library/react-native"
import i18n from "i18next"
import {Alert, AppState, BackHandler} from "react-native"
import Toast from "react-native-toast-message"

import {ModalProvider} from "@/contexts/ModalContext"
import {FleetSheets, runFleetSheets} from "@/effects/FleetSheets"
import en from "@/i18n/en"
import {useMyWorkspaceStore} from "@/services/fleet/myWorkspace"
import {
  type InvitationPreview,
  type MyWorkspace,
  setWorkspaceApi,
  type WorkspaceApi,
} from "@/services/fleet/workspaceApi"

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
          ? {is_ok: () => true, value: values.get(key)}
          : {is_ok: () => false, error: new Error(`No value found for ${key}`)},
      remove: (key: string) => values.delete(key),
      clearAll: () => values.clear(),
    },
  }
})
let mockUser: {id: string} | null = {id: "user-1"}
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: mockUser})}))

const RIDGELINE: MyWorkspace = {workspaceId: "ws-r", name: "Ridgeline Field Services", role: "member", membershipId: "m-1"}
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

/** The sheet's buttons, top to bottom. The backdrop is a button too, when the sheet can be dismissed, and has no text. */
const buttons = (screen: ReturnType<typeof render>) =>
  screen
    .getAllByRole("button")
    .flatMap((button) => within(button).queryAllByText(/./))
    .map((text) => String(text.props.children))

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
  it("shows the board's words, the can-see and can't-see lists, Join on top and Decline below", async () => {
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
    ;(core.api.accept as jest.Mock).mockRejectedValue(failWith("invitation_expired", "invitation_expired: raw server text"))
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
      const core = fakeCore({invitations: [invitation(RIDGELINE, {expiresAt: new Date(Date.now() + 30_000).toISOString()})]})
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
    await screen.findByText("You've now joined the Ridgeline Field Services workspace")
    await press(screen, "OK")
    await finish(run)
  })
})

describe("the leave-first variant", () => {
  it("names the current workspace, puts Leave on top, and goes Leave -> confirm -> Join", async () => {
    const core = fakeCore({mine: NORTHWIND, invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    // The notice for Northwind was already shown on an earlier start.
    require("@/utils/storage").storage.save("fleet.noticeShownMembershipId", NORTHWIND.membershipId)
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
    require("@/utils/storage").storage.save("fleet.noticeShownMembershipId", NORTHWIND.membershipId)
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
    require("@/utils/storage").storage.save("fleet.noticeShownMembershipId", NORTHWIND.membershipId)
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
})

describe("the Fleet notice", () => {
  const joinRidgeline = async (core: ReturnType<typeof fakeCore>) => {
    const run = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")
    await screen.findByText("You've now joined the Ridgeline Field Services workspace")
    return run
  }

  it("confirms the join in the board's words with OK only, and no handle", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = await joinRidgeline(core)

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
    await finish(run)
  })

  it("resists the swipe, the backdrop and Android back", async () => {
    const listeners: Array<() => boolean | null | undefined> = []
    const addListener = jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      listeners.push(listener)
      return {remove: () => listeners.splice(listeners.indexOf(listener), 1)}
    })
    try {
      const core = fakeCore({invitations: [invitation(RIDGELINE)]})
      setWorkspaceApi(core.api)
      screen = render(<ModalProvider>{null}</ModalProvider>)
      const run = await joinRidgeline(core)

      expect(mockDrag.enabled).toBe(false)
      await act(async () => {
        fireEvent.press(screen.getByTestId("alert.backdrop", {includeHiddenElements: true}))
      })
      let handled: boolean | null | undefined
      await act(async () => {
        handled = listeners[listeners.length - 1]?.()
      })
      expect(handled).toBe(true)
      expect(screen.getByText("You've now joined the Ridgeline Field Services workspace")).toBeTruthy()

      await press(screen, "OK")
      await finish(run)
      expect(screen.queryByText("You've now joined the Ridgeline Field Services workspace")).toBeNull()
    } finally {
      addListener.mockRestore()
    }
  })

  it("starts management before OK: the desired state is fetched while the notice is open", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = await joinRidgeline(core)

    expect(screen.getByText("OK")).toBeTruthy()
    expect(core.calls).toContain("refreshDesiredState")
    expect(core.calls.indexOf("accept:inv-ws-r")).toBeLessThan(core.calls.indexOf("refreshDesiredState"))

    await press(screen, "OK")
    await finish(run)
  })

  it("does not wait for the desired-state fetch, and a failed fetch does not stop the notice", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    ;(core.api.refreshDesiredState as jest.Mock).mockReturnValue(new Promise(() => {}))
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = await joinRidgeline(core)
    await press(screen, "OK")
    await finish(run)

    const failing = fakeCore({invitations: [invitation(NORTHWIND)]})
    ;(failing.api.refreshDesiredState as jest.Mock).mockRejectedValue(new Error("503"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      useMyWorkspaceStore.getState().reset()
      setWorkspaceApi(failing.api)
      const second = start()
      await screen.findByText("Northwind Labs invited you to join their workspace")
      await press(screen, "Join")
      expect(await screen.findByText("You've now joined the Northwind Labs workspace")).toBeTruthy()
      await press(screen, "OK")
      await finish(second)
    } finally {
      warn.mockRestore()
    }
  })

  it("shows once per join: not again after a restart", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = await joinRidgeline(core)
    await press(screen, "OK")
    await finish(run)

    // Restart: nothing is kept in memory, only what was stored.
    useMyWorkspaceStore.getState().reset()
    const afterRestart = start()
    await finish(afterRestart)
    expect(screen.queryByText("You've now joined the Ridgeline Field Services workspace")).toBeNull()
    expect(useMyWorkspaceStore.getState().workspace?.name).toBe("Ridgeline Field Services")
  })

  it("is not shown again for the same join when the app returns to the foreground", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = await joinRidgeline(core)
    await press(screen, "OK")
    await finish(run)

    const again = start()
    await finish(again)
    expect(screen.queryByText("OK")).toBeNull()
  })

  it("shows again after leaving and rejoining", async () => {
    const core = fakeCore({invitations: [invitation(RIDGELINE)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const first = await joinRidgeline(core)
    await press(screen, "OK")
    await finish(first)

    const {leaveWithConfirm} = require("@/effects/FleetSheets") as typeof import("@/effects/FleetSheets")
    let leaving!: Promise<string>
    act(() => {
      leaving = leaveWithConfirm(useMyWorkspaceStore.getState().workspace!)
    })
    await screen.findByText("Leave Ridgeline Field Services?")
    await press(screen, "Leave")
    await act(async () => {
      await expect(leaving).resolves.toBe("left")
    })

    core.state.invitations = [invitation(RIDGELINE)]
    const second = start()
    await screen.findByText("Ridgeline Field Services invited you to join their workspace")
    await press(screen, "Join")
    expect(await screen.findByText("You've now joined the Ridgeline Field Services workspace")).toBeTruthy()
    await press(screen, "OK")
    await finish(second)
  })

  it("shows for a membership that began elsewhere (the portal), once, and then the invitations", async () => {
    const core = fakeCore({mine: RIDGELINE, invitations: [invitation(NORTHWIND)]})
    setWorkspaceApi(core.api)
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const run = start()
    expect(await screen.findByText("You've now joined the Ridgeline Field Services workspace")).toBeTruthy()
    // The invitation waits its turn behind the notice.
    expect(screen.queryByText("Northwind Labs invited you to join their workspace")).toBeNull()
    await press(screen, "OK")
    expect(await screen.findByText("Northwind Labs invited you to join their workspace")).toBeTruthy()
    expect(screen.getByText("You're in Ridgeline Field Services. Leave it to join Northwind Labs.")).toBeTruthy()
    await press(screen, "Decline")
    await finish(run)
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
    const addListener = jest.spyOn(AppState, "addEventListener").mockImplementation(((_type: string, listener: never) => {
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
