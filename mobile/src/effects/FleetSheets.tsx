/**
 * The Fleet sheets: the workspace invitation (and its leave-first variant), the leave confirm and the Fleet
 * notice. They are the Mentra App's standard alert sheet (`showAlert`), never a native alert, and show one at
 * a time through its queue.
 *
 * Invitations are fetched at startup and each time the app returns to the foreground. The sheets wait for
 * the alert host (`waitForAlertHost`) so a cold start never falls back on a system alert.
 *
 * Words are verbatim from the Fleet design board (round 2); `UPDATE-2026-10-20.md` overrides older drawings.
 * The invitation is not swipeable (Decline cannot be undone), unlike the board's drawing.
 */
import {getFleetManagementState, onFleetManagementStateChanged} from "@mentra/engine-host-internal"
import {useEffect} from "react"
import {AppState, View} from "react-native"
import Toast from "react-native-toast-message"

import {Icon, Text} from "@/components/ignite"
import {dismissAlert, NO_ANSWER, showAlert, waitForAlertHost} from "@/contexts/ModalContext"
import {useAuth} from "@/contexts/AuthContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {type FleetManagementState} from "@/services/fleet/fleetManagement"
import {useMyWorkspaceStore} from "@/services/fleet/myWorkspace"
import {
  getWorkspaceApi,
  type InvitationPreview,
  type MyWorkspace,
  onWorkspaceApiReady,
  WORKSPACE_ERROR,
  workspaceErrorCode,
} from "@/services/fleet/workspaceApi"
import {storage} from "@/utils/storage"

/**
 * The workspace whose Fleet notice was last shown. It is forgotten when the person leaves, or when Fleet answers
 * that they are unmanaged, so a rejoin (the same workspace included) shows it again.
 */
const NOTICE_SHOWN_KEY = "fleet.noticeShownWorkspaceId"

/** `setTimeout` takes at most 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

// ---- Pieces the sheets and the workspace page share ------------------------------------------------------

/** The workspace's initial on a tile, as the board draws it. */
export function WorkspaceTile({name, size = 56}: {name: string; size?: number}) {
  return (
    <View
      className="items-center justify-center rounded-2xl bg-primary-foreground"
      style={{width: size, height: size}}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="fleet.workspaceTile">
      <Text
        text={name.trim().charAt(0).toUpperCase()}
        weight="semibold"
        className="text-2xl text-secondary-foreground"
      />
    </View>
  )
}

function SeeRow({text, allowed}: {text: string; allowed: boolean}) {
  const {theme} = useAppTheme()
  return (
    <View className="flex-row items-center gap-3 py-1.5">
      <View className="h-7 w-7 items-center justify-center rounded-full bg-primary-foreground">
        <Icon
          name={allowed ? "check" : "x"}
          size={18}
          color={allowed ? theme.colors.success : theme.colors.muted_foreground}
        />
      </View>
      <Text text={text} className="flex-1 text-[15px] text-secondary-foreground" />
    </View>
  )
}

/** What the workspace can and can't see: the same two lists on the invitation and on the workspace page. */
export function SeeLists() {
  return (
    <View className="gap-4" testID="fleet.seeLists">
      <View>
        <Text
          text={translate("fleet:canSeeTitle")}
          weight="semibold"
          accessibilityRole="header"
          className="mb-1 text-[15px] text-secondary-foreground"
        />
        <SeeRow allowed text={translate("fleet:canSeeGlassesAndPhones")} />
        <SeeRow allowed text={translate("fleet:canSeeMiniapps")} />
      </View>
      <View>
        <Text
          text={translate("fleet:cantSeeTitle")}
          weight="semibold"
          accessibilityRole="header"
          className="mb-1 text-[15px] text-secondary-foreground"
        />
        <SeeRow allowed={false} text={translate("fleet:cantSeePhotosAndVideos")} />
        <SeeRow allowed={false} text={translate("fleet:cantSeeSpeech")} />
        <SeeRow allowed={false} text={translate("fleet:cantSeePasswords")} />
      </View>
    </View>
  )
}

/** "Mentra Fleet Management · Managed by your workspace's admins". */
export function ManagementLine() {
  const {theme} = useAppTheme()
  return (
    <View
      className="flex-row items-center gap-3 rounded-2xl bg-primary-foreground px-4 py-3"
      testID="fleet.managementLine">
      <Icon name="shield-check" size={22} color={theme.colors.secondary_foreground} />
      <View className="flex-1">
        <Text
          text={translate("fleet:managementTitle")}
          weight="semibold"
          className="text-[15px] text-secondary-foreground"
        />
        <Text text={translate("fleet:managementSubtitle")} className="text-xs text-muted-foreground" />
      </View>
    </View>
  )
}

/** The role under the workspace's name. */
export function roleLabel(role: MyWorkspace["role"]): string {
  switch (role) {
    case "owner":
      return translate("fleet:roleOwner")
    case "admin":
      return translate("fleet:roleAdmin")
    case "developer":
      return translate("fleet:roleDeveloper")
    default:
      return translate("fleet:roleMember")
  }
}

// ---- Sheets ----------------------------------------------------------------------------------------------

/** Shows a sheet once the alert host is mounted. Never a system alert. */
async function present(request: Parameters<typeof showAlert>[0]): Promise<number> {
  await waitForAlertHost()
  return showAlert(request)
}

/** "Leave <workspace>?" Resolves true when the person confirms. */
export async function presentLeaveConfirm(workspaceName: string): Promise<boolean> {
  const answer = await present({
    title: translate("fleet:leaveConfirmTitle", {workspace: workspaceName}),
    message: translate("fleet:leaveConfirmMessage"),
    buttons: [
      {text: translate("fleet:leaveConfirmCancel"), style: "cancel"},
      {text: translate("fleet:leaveConfirmLeave"), style: "destructive"},
    ],
    options: {allowDismiss: true},
  })
  return answer === 1
}

/** The last Owner cannot leave from the phone. The copy is the whole sheet, so it is the title. */
async function presentLastOwner(): Promise<void> {
  await present({
    title: translate("fleet:lastOwner"),
    buttons: [{text: translate("fleet:noticeOk")}],
    options: {allowDismiss: false},
  })
}

/** The Fleet notice: a confirmation with OK only. It cannot be swiped, tapped away or backed out of. */
export async function presentNotice(workspaceName: string): Promise<void> {
  await present({
    title: translate("fleet:noticeTitle", {workspace: workspaceName}),
    message: translate("fleet:noticeBody", {workspace: workspaceName}),
    buttons: [{text: translate("fleet:noticeOk")}],
    options: {icon: <WorkspaceTile name={workspaceName} />, content: <ManagementLine />, allowDismiss: false},
  })
}

const JOIN = 1
const DECLINE = 0

/**
 * The invitation. The main action is Join, or "Leave <current>" when the person is already in a workspace.
 * Decline is its cancel button, but the sheet is not swipeable: Decline cannot be undone.
 */
function presentInvitation(invitation: InvitationPreview, current: MyWorkspace | null): Promise<number> {
  return present({
    title: translate("fleet:invitationTitle", {workspace: invitation.workspaceName}),
    message: translate("fleet:invitationTerms"),
    buttons: [
      {text: translate("fleet:invitationDecline"), style: "cancel"},
      {
        text: current
          ? translate("fleet:invitationLeaveCurrent", {current: current.name})
          : translate("fleet:invitationJoin"),
      },
    ],
    options: {
      icon: <WorkspaceTile name={invitation.workspaceName} />,
      content: (
        <View className="gap-4">
          <SeeLists />
          {current && (
            <Text
              text={translate("fleet:invitationLeaveFirst", {
                current: current.name,
                workspace: invitation.workspaceName,
              })}
              weight="semibold"
              className="text-center text-[15px] text-secondary-foreground"
              testID="fleet.leaveFirstRule"
            />
          )}
        </View>
      ),
      allowDismiss: false,
    },
  })
}

// ---- Flow ------------------------------------------------------------------------------------------------

function toast(key: "fleet:invitationExpired" | "fleet:somethingWentWrong"): void {
  Toast.show({type: "error", text1: translate(key)})
}

/** Asks Fleet for the desired state now. A failure is not the sheets' to report: the next ack catches up. */
function refreshDesiredStateNow(): void {
  try {
    void getWorkspaceApi()
      .refreshDesiredState()
      .catch((error) => console.warn("Fleet: desired-state fetch failed", error))
  } catch (error) {
    console.warn("Fleet: desired-state fetch failed", error)
  }
}

const shownNoticeFor = (): string | null => {
  const saved = storage.load<string>(NOTICE_SHOWN_KEY)
  return saved.is_ok() ? saved.value : null
}

/** Notices on screen or waiting, by workspace: a change heard twice never queues the notice twice. */
const noticePending = new Set<string>()

/**
 * The Fleet notice follows what Fleet says. It shows on the first move to `managed` for a workspace whose notice
 * has not been shown, and never while the state is `unknown` or `unmanaged`. It is marked shown first, so a
 * restart never shows it again. An `unmanaged` answer forgets it, so the next join shows it again.
 */
export async function showNoticeForFleetState(state: FleetManagementState = getFleetManagementState()): Promise<void> {
  if (state.status === "unmanaged") {
    storage.remove(NOTICE_SHOWN_KEY)
    return
  }
  if (state.status !== "managed") return
  if (shownNoticeFor() === state.workspaceId || noticePending.has(state.workspaceId)) return
  noticePending.add(state.workspaceId)
  try {
    storage.save(NOTICE_SHOWN_KEY, state.workspaceId)
    await presentNotice(state.workspaceName)
  } finally {
    noticePending.delete(state.workspaceId)
  }
}

/** The person left their workspace. Fleet's `unmanaged` answer, fetched at once, lets the notice show again. */
function leftWorkspace(): void {
  useMyWorkspaceStore.getState().set(null)
  refreshDesiredStateNow()
}

/** How a leave through its confirm sheet ended. */
export type LeaveOutcome = "left" | "cancelled" | "last_owner" | "failed"

/**
 * Leaves the current workspace: the confirm sheet, then Core, then at once Fleet's desired state. The caller
 * words `last_owner` (the only Owner cannot leave from the phone); a failure has already been toasted.
 */
export async function leaveWithConfirm(current: MyWorkspace): Promise<LeaveOutcome> {
  if (!(await presentLeaveConfirm(current.name))) return "cancelled"
  try {
    await getWorkspaceApi().leave()
  } catch (error) {
    if (workspaceErrorCode(error) === WORKSPACE_ERROR.lastOwner) return "last_owner"
    toast("fleet:somethingWentWrong")
    return "failed"
  }
  leftWorkspace()
  return "left"
}

/**
 * One invitation, start to finish: ask, then join, decline, or leave first. The sheet shows again after a
 * refusal that the person can retry (a failed call, a cancelled leave).
 */
async function handleInvitation(invitation: InvitationPreview): Promise<void> {
  const api = getWorkspaceApi()
  const expiresIn = () => new Date(invitation.expiresAt).getTime() - Date.now()
  let expired = false

  for (;;) {
    const current = useMyWorkspaceStore.getState().workspace
    if (current?.workspaceId === invitation.workspaceId) return
    if (expired || expiresIn() <= 0) {
      if (expired) toast("fleet:invitationExpired")
      return
    }

    // An invitation that runs out while its sheet is open closes with a toast.
    const wait = expiresIn()
    const timer =
      wait <= MAX_TIMER_MS
        ? setTimeout(() => {
            expired = true
            dismissAlert(translate("fleet:invitationTitle", {workspace: invitation.workspaceName}))
          }, wait)
        : undefined
    let answer: number
    try {
      answer = await presentInvitation(invitation, current)
    } finally {
      clearTimeout(timer)
    }

    if (expired) {
      toast("fleet:invitationExpired")
      return
    }
    if (answer === NO_ANSWER) return

    if (answer === DECLINE) {
      try {
        await api.decline(invitation.invitationId)
      } catch (error) {
        const code = workspaceErrorCode(error)
        toast(
          code === WORKSPACE_ERROR.invitationExpired || code === WORKSPACE_ERROR.invitationNotFound
            ? "fleet:invitationExpired"
            : "fleet:somethingWentWrong",
        )
      }
      return
    }

    if (answer === JOIN && current) {
      if ((await leaveWithConfirm(current)) === "last_owner") await presentLastOwner()
      continue
    }

    try {
      const joined = await api.accept(invitation.invitationId)
      useMyWorkspaceStore.getState().set(joined)
      // The notice follows Fleet's answer: it shows when the phone first hears `managed`.
      refreshDesiredStateNow()
      return
    } catch (error) {
      const code = workspaceErrorCode(error)
      if (code === WORKSPACE_ERROR.invitationExpired || code === WORKSPACE_ERROR.invitationNotFound) {
        toast("fleet:invitationExpired")
        return
      }
      if (code === WORKSPACE_ERROR.alreadyInWorkspace) {
        const mine = await getWorkspaceApi()
          .mine()
          .catch(() => null)
        if (mine) useMyWorkspaceStore.getState().set(mine)
        continue
      }
      toast("fleet:somethingWentWrong")
    }
  }
}

/** One look at Core: the person's workspace, then each invitation. */
async function pass(): Promise<void> {
  const api = getWorkspaceApi()
  const [mine, invitations] = await Promise.allSettled([api.mine(), api.invitations()])

  if (mine.status === "fulfilled") {
    useMyWorkspaceStore.getState().set(mine.value)
  } else {
    console.warn("Fleet: could not read the workspace", mine.reason)
  }

  if (invitations.status === "rejected") {
    console.warn("Fleet: could not read invitations", invitations.reason)
    return
  }
  for (const invitation of invitations.value) {
    await handleInvitation(invitation)
  }
}

let running: Promise<void> | null = null
let again = false

/**
 * Looks for the notice and invitations to show, and shows them one at a time. Calls made while sheets are
 * up are folded into one more look afterwards, so foreground events never stack duplicate sheets.
 */
export function runFleetSheets(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    try {
      do {
        again = false
        try {
          await pass()
        } catch (error) {
          console.warn("Fleet: sheets failed", error)
        }
      } while (again)
    } finally {
      running = null
    }
  })()
  return running
}

/**
 * Runs the Fleet sheets at startup, on foreground and once the workspace client answers for the signed-in
 * account, and the notice on
 * Fleet's answers, while someone is signed in.
 */
export function FleetSheets() {
  const {user} = useAuth()
  const userId = user?.id

  useEffect(() => {
    if (!userId) {
      useMyWorkspaceStore.getState().reset()
      return
    }
    void runFleetSheets()
    void showNoticeForFleetState()
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void runFleetSheets()
    })
    const unready = onWorkspaceApiReady(() => void runFleetSheets())
    const unsubscribe = onFleetManagementStateChanged((state) => void showNoticeForFleetState(state))
    return () => {
      subscription.remove()
      unready()
      unsubscribe()
    }
  }, [userId])

  return null
}
