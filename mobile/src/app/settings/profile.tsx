import {useState, useEffect} from "react"
import {View, Image, ActivityIndicator, ScrollView, ImageStyle, ViewStyle, Modal} from "react-native"
import Svg, {Path} from "react-native-svg"

import {Header, Screen, Text} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAuth} from "@/contexts/AuthContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import restComms from "@/services/RestComms"
import {$styles, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {LogoutUtils} from "@/utils/LogoutUtils"
import mentraAuth from "@/utils/auth/authClient"
import {useAppTheme} from "@/utils/useAppTheme"

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

  const {goBack, push, replace} = useNavigationHistory()
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
    push("/settings/data-export")
  }

  const handleChangePassword = () => {
    console.log("Profile: Navigating to change password screen")
    push("/settings/change-password")
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

    let deleteRequestSuccessful = false

    console.log("Profile: Requesting account deletion from server")
    const result = await restComms.requestAccountDeletion()

    // Check if the result indicates success
    if (result.is_ok()) {
      deleteRequestSuccessful = true
      console.log("Profile: Account deletion request successful")
    } else {
      console.error("Profile: Error requesting account deletion:", result.error)
      deleteRequestSuccessful = false
    }

    // Always perform logout regardless of deletion request success
    try {
      console.log("Profile: Starting comprehensive logout")
      await LogoutUtils.performCompleteLogout()
      console.log("Profile: Logout completed successfully")
    } catch (logoutError) {
      console.error("Profile: Error during logout:", logoutError)
      // Continue with navigation even if logout fails
    }

    // Show appropriate message based on deletion request result
    if (deleteRequestSuccessful) {
      showAlert(
        translate("profileSettings:deleteAccountSuccessTitle"),
        translate("profileSettings:deleteAccountSuccessMessage"),
        [
          {
            text: translate("common:ok"),
            onPress: () => replace("/"),
          },
        ],
        {cancelable: false},
      )
    } else {
      showAlert(
        translate("profileSettings:deleteAccountPendingTitle"),
        translate("profileSettings:deleteAccountPendingMessage"),
        [
          {
            text: translate("common:ok"),
            onPress: () => replace("/"),
          },
        ],
        {cancelable: false},
      )
    }
  }

  const handleSignOut = async () => {
    try {
      console.log("Profile: Starting sign-out process")
      setIsSigningOut(true)

      await logout()

      console.log("Profile: Logout completed, navigating to login")

      // Reset the loading state before navigation
      setIsSigningOut(false)

      // Navigate to Login screen directly instead of SplashScreen
      // This ensures we skip the SplashScreen logic that might detect stale user data
      replace("/")
    } catch (err) {
      console.error("Profile: Error during sign-out:", err)
      setIsSigningOut(false)

      // Show user-friendly error but still navigate to login to prevent stuck state
      showAlert(translate("common:error"), translate("settings:signOutError"), [
        {
          text: translate("common:ok"),
          onPress: () => replace("/"),
        },
      ])
    }
  }

  const confirmSignOut = () => {
    showAlert(
      translate("settings:signOut"),
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
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header title={translate("profileSettings:title")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView>
        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.palette.primary500} />
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
              {userData.provider == "email" && (
                <RouteButton label={translate("profileSettings:changePassword")} onPress={handleChangePassword} />
              )}
              <RouteButton label={translate("profileSettings:requestDataExport")} onPress={handleRequestDataExport} />
              <RouteButton
                label={translate("profileSettings:deleteAccount")}
                onPress={handleDeleteAccount}
                variant="destructive"
              />
              <RouteButton label={translate("settings:signOut")} onPress={confirmSignOut} variant="destructive" />
            </Group>
          </>
        ) : (
          <>
            {/* Sign out button - always available, even if user data fails to load */}
            <RouteButton label={translate("settings:signOut")} onPress={confirmSignOut} />
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
            <ActivityIndicator size="large" color={theme.colors.tint} style={{marginBottom: theme.spacing.s4}} />
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
