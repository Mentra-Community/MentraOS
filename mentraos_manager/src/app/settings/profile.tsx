import React, {useState, useEffect} from "react"
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  ScrollView,
  ImageStyle,
  TextStyle,
  ViewStyle,
} from "react-native"
import {supabase} from "@/supabase/supabaseClient"
import Icon from "react-native-vector-icons/FontAwesome"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import {useAuth} from "@/contexts/AuthContext"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {router} from "expo-router"
import {translate} from "@/i18n"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import ActionButton from "@/components/ui/ActionButton"
import showAlert from "@/utils/AlertUtils"
import {LogoutUtils} from "@/utils/LogoutUtils"

export default function ProfileSettingsPage() {
  const [userData, setUserData] = useState<{
    fullName: string | null
    avatarUrl: string | null
    email: string | null
    createdAt: string | null
    provider: string | null
  } | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  const {goBack, push} = useNavigationHistory()

  useEffect(() => {
    const fetchUserData = async () => {
      setLoading(true)
      try {
        const {
          data: {user},
          error,
        } = await supabase.auth.getUser()
        if (error) {
          console.error(error)
          setUserData(null)
        } else if (user) {
          const fullName = user.user_metadata?.full_name || user.user_metadata?.name || null
          const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || null
          const email = user.email || null
          const createdAt = user.created_at || null
          const provider = user.app_metadata?.provider || null

          setUserData({
            fullName,
            avatarUrl,
            email,
            createdAt,
            provider,
          })
        }
      } catch (error) {
        console.error(error)
        setUserData(null)
      } finally {
        setLoading(false)
      }
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
                          translate("profileSettings:deleteAccountWarning2Message") + "\n\n" + 
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
    let errorMessage = ""

    try {
      console.log("Profile: Requesting account deletion from server")
      const response = await BackendServerComms.getInstance().requestAccountDeletion()

      // Check if the response indicates success
      deleteRequestSuccessful = response && (response.success === true || response.status === "success")
      console.log("Profile: Account deletion request successful:", deleteRequestSuccessful)
    } catch (error) {
      console.error("Profile: Error requesting account deletion:", error)
      deleteRequestSuccessful = false
      errorMessage = error instanceof Error ? error.message : String(error)
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
            onPress: () => router.replace("/"),
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
            onPress: () => router.replace("/"),
          },
        ],
        {cancelable: false},
      )
    }
  }

  const {theme, themed} = useAppTheme()

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}}>
      <Header title={translate("profileSettings:title")} leftIcon="caretLeft" onLeftPress={goBack} />
      <ScrollView>
        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.palette.primary500} />
        ) : userData ? (
          <>
            {userData.avatarUrl ? (
              <Image source={{uri: userData.avatarUrl}} style={themed($profileImage)} />
            ) : (
              <View style={themed($profilePlaceholder)}>
                <Text tx="profileSettings:noProfilePicture" style={themed($profilePlaceholderText)} />
              </View>
            )}

            <View style={themed($infoContainer)}>
              <Text tx="profileSettings:name" style={themed($label)} />
              <Text text={userData.fullName || "N/A"} style={themed($infoText)} />
            </View>

            <View style={themed($infoContainer)}>
              <Text tx="profileSettings:email" style={themed($label)} />
              <Text text={userData.email || "N/A"} style={themed($infoText)} />
            </View>

            <View style={themed($infoContainer)}>
              <Text tx="profileSettings:createdAt" style={themed($label)} />
              <Text
                text={userData.createdAt ? new Date(userData.createdAt).toLocaleString() : "N/A"}
                style={themed($infoText)}
              />
            </View>

            {userData.provider == "email" && (
              <ActionButton
                label={translate("profileSettings:changePassword")}
                variant="default"
                onPress={handleChangePassword}
                containerStyle={{marginBottom: theme.spacing.xs}}
              />
            )}

            <ActionButton
              label={translate("profileSettings:requestDataExport")}
              variant="default"
              onPress={handleRequestDataExport}
              containerStyle={{marginBottom: theme.spacing.xs}}
            />

            <ActionButton
              label={translate("profileSettings:deleteAccount")}
              variant="destructive"
              onPress={handleDeleteAccount}
            />
          </>
        ) : (
          <Text tx="profileSettings:errorGettingUserInfo" />
        )}
      </ScrollView>
    </Screen>
  )
}

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontWeight: "bold",
  fontSize: 16,
  color: colors.text,
})

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  flex: 1,
})

const $contentContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  flex: 1,
})

const $header: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  flex: 1,
})

const darkHeader: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  flex: 1,
})

const $deleteAccountButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.palette.angry500,
})

const $requestDataExportButton: ThemedStyle<ViewStyle> = ({colors}) => ({})

const $requestDataExportButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.palette.primary500,
})

const $deleteAccountButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.palette.primary500,
})

const $profileImage: ThemedStyle<ImageStyle> = ({colors}) => ({
  width: 100,
  height: 100,
  borderRadius: 50,
  alignSelf: "center",
  marginBottom: 20,
})

const $profilePlaceholder: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: 100,
  height: 100,
  borderRadius: 50,
  justifyContent: "center",
  alignItems: "center",
  alignSelf: "center",
  marginBottom: 20,
})

const $profilePlaceholderText: ThemedStyle<TextStyle> = ({colors}) => ({
  textAlign: "center",
  color: colors.text,
})

const $infoContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  marginBottom: 15,
})

const $infoText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  marginTop: 4,
  color: colors.text,
})

const $headerContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 20,
})

const $backButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  width: 60,
})

const $backButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  marginLeft: 5,
  fontSize: 16,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 24,
  fontWeight: "bold",
  textAlign: "center",
})

const $lightProfilePlaceholder: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.palette.lightGray,
})

const $darkProfilePlaceholder: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.palette.gray800,
})

const $navigationBarContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
})

const $inputIcon: ThemedStyle<ViewStyle> = ({colors}) => ({
  marginRight: 12,
})
