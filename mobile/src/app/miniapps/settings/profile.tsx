import {useState, useEffect} from "react"
import {View, Image, ActivityIndicator, ScrollView, ImageStyle, ViewStyle, Modal} from "react-native"
import Svg, {Path} from "react-native-svg"

import {Header, Screen, Text} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAuth} from "@/contexts/AuthContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCapsuleStore} from "@/stores/capsule"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"
import {settleFrame} from "@/utils/settleFrame"

// Default user icon component for profile pictures
const DefaultUserIcon = ({size = 100, color = "#999"}: {size?: number; color?: string}) => {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 12C14.7614 12 17 9.76142 17 7C17 4.23858 14.7614 2 12 2C9.23858 2 7 4.23858 7 7C7 9.76142 9.23858 12 12 12Z"
        fill={color}
      />
      <Path d="M12 14C6.47715 14 2 17.5817 2 22H22C22 17.5817 17.5228 14 12 14Z" fill={color} />
    </Svg>
  )
}

export default function ProfileSettingsPage() {
  const [userData, setUserData] = useState<{
    fullName: string | null
    avatarUrl: string | null
    email: string | null
    createdAt: string | null
    provider: string | null
  } | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [isSigningOut, setIsSigningOut] = useState(false)

  const {goBack, push, replaceAll} = useNavigationStore.getState()
  const {logout} = useAuth()

  useEffect(() => {
    const fetchUserData = async () => {
      setLoading(true)
      const res = await mentraAuth.getUser()
      if (res.is_error()) {
        console.error(res.error)
        setUserData(null)
        return
      }
      const user = res.value
      if (!user) {
        setUserData(null)
        setLoading(false)
        return
      }

      const fullName = user.name || null
      const avatarUrl = user.avatarUrl || null
      const email = user.email || null
      const createdAt = user.createdAt || null
      const provider = user.provider || null

      setUserData({
        fullName,
        avatarUrl,
        email,
        createdAt,
        provider,
      })
      setLoading(false)
    }

    fetchUserData()
  }, [])

  const handleRequestDataExport = () => {
    console.log("Profile: Navigating to data export screen")
    push("/miniapps/settings/data-export")
  }

  const handleChangePassword = () => {
    console.log("Profile: Navigating to change password screen")
    push("/miniapps/settings/change-password")
  }

  const handleChangeEmail = () => {
    console.log("Profile: Navigating to change email screen")
    push("/miniapps/settings/change-email")
  }

  const handleDeleteAccount = () => {
    console.log("Profile: Starting account deletion process - Step 1")

    // Step 1: Initial warning
    showAlert(
      translate("profileSettings:deleteAccountWarning1Title"),
      translate("profileSettings:deleteAccountWarning1Message"),
      [
        {text: translate("common:cancel"), style: "cancel"},
        {
          text: translate("common:continue"),
          onPress: () => {
            console.log("Profile: User passed step 1 - Step 2")

            // Step 2: Generic confirmation - delay to let first modal close
            setTimeout(() => {
              showAlert(
                translate("profileSettings:deleteAccountTitle"),
                translate("profileSettings:deleteAccountMessage"),
                [
                  {text: translate("common:cancel"), style: "cancel"},
                  {
                    text: translate("common:continue"),
                    onPress: () => {
                      console.log("Profile: User passed step 2 - Step 3")

                      // Step 3: Final severe warning - delay to let second modal close
                      setTimeout(() => {
                        showAlert(
                          translate("profileSettings:deleteAccountWarning2Title"),
                          translate("profileSettings:deleteAccountWarning2Message") +
                            "\n\n" +
                            "⚠️ THIS IS YOUR FINAL CHANCE TO CANCEL ⚠️",
                          [
                            {text: translate("common:cancel"), style: "cancel"},
                            {
                              text: "DELETE PERMANENTLY",
                              onPress: proceedWithAccountDeletion,
                            },
                          ],
                          {cancelable: false},
                        )
                      }, 100)
                    },
                  },
                ],
                {cancelable: false},
              )
            }, 100)
          },
        },
      ],
      {cancelable: false},
    )
  }

  const proceedWithAccountDeletion = async () => {
    console.log("Profile: User confirmed account deletion - proceeding")

    // Account backend flow (issue 019): request emails a one-time code; the
    // account is only destroyed when the code is confirmed. Keep the session
    // alive here — the confirm call needs it — and finish (including logout)
    // on the confirm-deletion screen.
    const result = await mentraAuth.requestAccountDeletion()
    if (result.is_error()) {
      console.error("Profile: Error requesting account deletion:", result.error)
      showAlert(translate("common:error"), mapAuthError(result.error), [{text: translate("common:ok")}])
      return
    }
    push("/miniapps/settings/confirm-deletion")
  }

  const handleSignOut = async () => {
    try {
      console.log("Profile: Starting sign-out process")
      setIsSigningOut(true)

      // Leave the miniapp surface BEFORE logging out, not after.
      //
      // This screen renders inside the Settings miniapp, and logout destroys
      // that runtime (LogoutUtils → mantle.cleanup() → localMiniappRuntime
      // .cleanup()). Navigating afterwards meant this component was still
      // mounted in a container that no longer existed, so Fabric tried to
      // reparent a view that still had a parent:
      //
      //   addViewAt: failed to insert view [N] into parent [M] at index 0
      //
      // React Native escalates that to a host exception and destroys the
      // ReactHost. The app is then a white screen that navigation cannot fix
      // and only a force-quit clears — which is what users described as
      // "SSO sends me back to login until I close and reopen the app"
      // (OS-1834). Navigating first means this screen is already gone by the
      // time its runtime is torn down.
      //
      // Close this miniapp the way its own X button does. Router navigation is
      // not enough on its own: the miniapp is an overlay above the router, so
      // moving the root stack underneath it leaves this screen sitting on top,
      // still showing the account we just signed out of.
      // Awaited, not fire-and-forget. The only implementation today is
      // synchronous, but the contract is `Promise<void> | void` and it is
      // documented as capturing a screenshot first. If an async one lands, an
      // unawaited close would still be running while the teardown below starts
      // — putting us right back in the race this exists to prevent.
      await useCapsuleStore.getState().active?.handleRightPress(true)
      await settleFrame()

      // Straight to the login route, not to "/": going home remounts index.tsx,
      // which starts its whole boot sequence against the session we are about
      // to destroy and then fires clearHistoryAndGoHome() from inside that
      // flow — landing back on a signed-out home shell no matter where we
      // navigate afterwards. /auth/start has no session check, so it is stable
      // to sit on while the teardown runs, and it is where we want to end up.
      replaceAll("/auth/start")
      await settleFrame()

      await logout()

      console.log("Profile: Logout completed")
      setIsSigningOut(false)
    } catch (err) {
      console.error("Profile: Error during sign-out:", err)
      setIsSigningOut(false)

      // Still get the user to the login screen rather than leaving them stuck,
      // but to /auth/start like the success path — not "/". A logout that threw
      // may have torn down some of the runtime already, and "/" remounts
      // index.tsx, which boots against exactly that half-destroyed session.
      // That is the flow the happy path deliberately avoids, so the error path
      // must not walk back into it.
      showAlert(translate("common:error"), translate("settings:signOutError"), [
        {
          text: translate("common:ok"),
          onPress: () => replaceAll("/auth/start"),
        },
      ])
    }
  }

  const confirmSignOut = () => {
    showAlert(
      translate("common:logOut"),
      translate("settings:signOutConfirm"),
      [
        {text: translate("common:cancel"), style: "cancel"},
        {text: translate("common:yes"), onPress: handleSignOut},
      ],
      {cancelable: false},
    )
  }

  const {theme, themed} = useAppTheme()

  return (
    <Screen preset="fixed">
      <Header title={translate("profileSettings:title")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView className="px-6 -mx-6">
        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.foreground} />
        ) : userData ? (
          <>
            <View style={themed($profileSection)}>
              {userData.avatarUrl ? (
                <Image source={{uri: userData.avatarUrl}} style={themed($profileImage)} />
              ) : (
                <View style={themed($profilePlaceholder)}>
                  <DefaultUserIcon size={60} color={theme.colors.textDim} />
                </View>
              )}
            </View>

            <Group>
              <RouteButton label={translate("profileSettings:name")} text={userData.fullName || "N/A"} />
              <RouteButton label={translate("profileSettings:email")} text={userData.email || "N/A"} />
              <RouteButton
                label={translate("profileSettings:createdAt")}
                text={userData.createdAt ? new Date(userData.createdAt).toLocaleString() : "N/A"}
              />
            </Group>

            <Spacer height={theme.spacing.s6} />

            <Group title={translate("account:appSettings")}>
              {/* Show password/email options only for email/password users (not OAuth) */}
              {userData.provider !== "google" && userData.provider !== "apple" && (
                <RouteButton label={translate("profileSettings:changePassword")} onPress={handleChangePassword} />
              )}
              {userData.provider !== "google" && userData.provider !== "apple" && (
                <RouteButton label={translate("profileSettings:changeEmail")} onPress={handleChangeEmail} />
              )}
              <RouteButton label={translate("profileSettings:requestDataExport")} onPress={handleRequestDataExport} />
              <RouteButton
                label={translate("profileSettings:deleteAccount")}
                onPress={handleDeleteAccount}
                preset="destructive"
              />
              <RouteButton label={translate("common:logOut")} onPress={confirmSignOut} preset="destructive" />
            </Group>
          </>
        ) : (
          <>
            {/* Sign out button - always available, even if user data fails to load */}
            <RouteButton label={translate("common:logOut")} onPress={confirmSignOut} />
            <Text tx="profileSettings:errorGettingUserInfo" />
          </>
        )}
      </ScrollView>

      {/* Loading overlay for sign out */}
      <Modal visible={isSigningOut} transparent={true} animationType="fade">
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(0, 0, 0, 0.7)",
            justifyContent: "center",
            alignItems: "center",
          }}>
          <View
            style={{
              backgroundColor: theme.colors.background,
              padding: theme.spacing.s8,
              borderRadius: theme.spacing.s4,
              alignItems: "center",
              minWidth: 200,
            }}>
            <ActivityIndicator size="large" color={theme.colors.foreground} style={{marginBottom: theme.spacing.s4}} />
            <Text preset="bold" style={{color: theme.colors.text}}>
              {translate("settings:loggingOutMessage")}
            </Text>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}

const $profileSection: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "center",
  paddingHorizontal: spacing.s4,
  paddingTop: spacing.s4,
  paddingBottom: spacing.s6,
})

const $profileImage: ThemedStyle<ImageStyle> = () => ({
  width: 100,
  height: 100,
  borderRadius: 50,
})

const $profilePlaceholder: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: 100,
  height: 100,
  borderRadius: 50,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: colors.border,
})
