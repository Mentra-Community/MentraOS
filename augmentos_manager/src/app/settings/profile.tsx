import React, {useState, useEffect} from "react"
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  ScrollView,
  Alert,
  ImageStyle,
  TextStyle,
  ViewStyle,
} from "react-native"
import {supabase} from "@/supabase/supabaseClient"
import Icon from "react-native-vector-icons/FontAwesome"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import {useAuth} from "@/contexts/AuthContext"
import {Button, Header, Screen} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {router} from "expo-router"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

export default function ProfileSettingsPage() {
  const [userData, setUserData] = useState<{
    fullName: string | null
    avatarUrl: string | null
    email: string | null
    createdAt: string | null
    provider: string | null
  } | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  const [showChangePassword, setShowChangePassword] = useState(false)
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordMatched, setPasswordMatched] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const {logout} = useAuth()

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
    showAlert(
      translate("profileSettings:dataExportTitle"),
      translate("profileSettings:dataExportMessage"),
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate("common:yes"),
          onPress: async () => {
            try {
              console.log("Not implemented yet!!!");
              // BackendServerComms.getInstance().requestDataExport();
              // show an alert saying the user will receive an email with a link to download the data
            } catch (error) {
              console.error("Error requesting data export:", error)
            }
          },
        },
      ],
      { cancelable: false }
    )
  }

  const handleDeleteAccount = () => {
    console.log("Deleting account")
    Alert.alert(translate("profileSettings:deleteAccountTitle"), translate("profileSettings:deleteAccountMessage"), [
      {text: translate("common:cancel"), style: "cancel"},
      {
        text: translate("common:delete"),
        style: "destructive",
        onPress: async () => {
          try {
            await BackendServerComms.getInstance().requestAccountDeletion()
          } catch (error) {
            console.error(error)
          }
          await logout()
        },
      },
    ])
  }

  const {theme, themed} = useAppTheme()

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.md}}>
      <Header
        title={translate("profileSettings:title")}
        leftIcon="caretLeft"
        onLeftPress={() => router.replace("/(tabs)/settings")}
      />
      <ScrollView>
        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.palette.primary500} />
        ) : userData ? (
          <>
            {userData.avatarUrl ? (
              <Image source={{uri: userData.avatarUrl}} style={themed($profileImage)} />
            ) : (
              <View style={themed($profilePlaceholder)}>
                <Text style={themed($profilePlaceholderText)}>{translate("profileSettings:noProfilePicture")}</Text>
              </View>
            )}

            <View style={themed($infoContainer)}>
              <Text style={themed($label)}>{translate("profileSettings:name")}</Text>
              <Text style={themed($infoText)}>{userData.fullName || "N/A"}</Text>
            </View>

            <View style={themed($infoContainer)}>
              <Text style={themed($label)}>{translate("profileSettings:email")}</Text>
              <Text style={themed($infoText)}>{userData.email || "N/A"}</Text>
            </View>

            <View style={themed($infoContainer)}>
              <Text style={themed($label)}>{translate("profileSettings:createdAt")}</Text>
              <Text style={themed($infoText)}>
                {userData.createdAt ? new Date(userData.createdAt).toLocaleString() : "N/A"}
              </Text>
            </View>

            <View style={themed($infoContainer)}>
              <Text style={themed($label)}>{translate("profileSettings:provider")}</Text>
              <View style={{flexDirection: "row", alignItems: "center", marginTop: 4}}>
                {userData.provider === "google" && (
                  <>
                    <Icon name="google" size={18} />
                    <View style={{width: 6}} />
                  </>
                )}
                {userData.provider === "apple" && (
                  <>
                    <Icon name="apple" size={18} />
                    <View style={{width: 6}} />
                  </>
                )}
                {userData.provider === "facebook" && (
                  <>
                    <Icon name="facebook" size={18} color="#4267B2" />
                    <View style={{width: 6}} />
                  </>
                )}
                {userData.provider === "email" && (
                  <>
                    <Icon name="envelope" size={18} />
                    <View style={{width: 6}} />
                  </>
                )}
              </View>
            </View>

            {userData.provider == "email" && (
              <TouchableOpacity
                onPress={() => setShowChangePassword(!showChangePassword)}
                style={themed($changePasswordButton)}>
                <Text style={themed($changePasswordButtonText)}>{translate("profileSettings:changePassword")}</Text>
              </TouchableOpacity>
            )}

            {showChangePassword && (
              <View style={themed($passwordChangeContainer)}>
                <View style={themed($inputGroup)}>
                  <Text style={themed($inputLabel)}>{translate("profileSettings:newPassword")}</Text>
                  <View style={themed($enhancedInputContainer)}>
                    <Icon name="lock" size={16} color="#6B7280" />
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={themed($enhancedInput)}
                      placeholder={translate("profileSettings:enterNewPassword")}
                      value={newPassword}
                      autoCapitalize="none"
                      onChangeText={(text: any) => {
                        setNewPassword(text)
                        setPasswordMatched(text === confirmPassword)
                      }}
                      secureTextEntry={!showNewPassword}
                      placeholderTextColor="#9CA3AF"
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={() => setShowNewPassword(!showNewPassword)}>
                      <Icon name={showNewPassword ? "eye" : "eye-slash"} size={18} color="#6B7280" />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={themed($inputGroup)}>
                  <Text style={themed($inputLabel)}>{translate("profileSettings:confirmPassword")}</Text>
                  <View style={themed($enhancedInputContainer)}>
                    <Icon name="lock" size={16} color="#6B7280" />
                    <TextInput
                      hitSlop={{top: 16, bottom: 16}}
                      style={themed($enhancedInput)}
                      placeholder={translate("profileSettings:confirmNewPassword")}
                      value={confirmPassword}
                      autoCapitalize="none"
                      onChangeText={(text: any) => {
                        setConfirmPassword(text)
                        setPasswordMatched(text === newPassword)
                      }}
                      secureTextEntry={!showConfirmPassword}
                      placeholderTextColor="#9CA3AF"
                    />
                    <TouchableOpacity
                      hitSlop={{top: 16, bottom: 16, left: 16, right: 16}}
                      onPress={() => setShowConfirmPassword(!showConfirmPassword)}>
                      <Icon name={showConfirmPassword ? "eye" : "eye-slash"} size={18} color="#6B7280" />
                    </TouchableOpacity>
                  </View>
                </View>

                <TouchableOpacity
                  style={[
                    themed($updatePasswordButton),
                    passwordMatched ? themed($activeUpdatePasswordButton) : themed($disabledUpdatePasswordButton),
                  ]}
                  disabled={!passwordMatched}
                  onPress={() => {
                    console.log("Password updated:", newPassword)
                    setShowChangePassword(false)
                    setNewPassword("")
                    setConfirmPassword("")
                  }}>
                  <Text style={themed($updatePasswordButtonText)}>{translate("profileSettings:updatePassword")}</Text>
                </TouchableOpacity>
              </View>
            )}

            <Button style={themed($requestDataExportButton)} onPress={handleRequestDataExport}>
              <Text style={themed($requestDataExportButtonText)}>{translate("profileSettings:requestDataExport")}</Text>
            </Button>
            <View style={{height: 10}} />
            <Button style={themed($deleteAccountButton)} onPress={handleDeleteAccount}>
              <Text style={themed($deleteAccountButtonText)}>{translate("profileSettings:deleteAccount")}</Text>
            </Button>
          </>
        ) : (
          <Text>{translate("profileSettings:errorGettingUserInfo")}</Text>
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

const $updatePasswordButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.palette.primary500,
  padding: 10,
  borderRadius: 5,
})

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
})

const $infoContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  marginBottom: 15,
})

const $infoText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  marginTop: 4,
})

const $changePasswordButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  alignSelf: "auto",
  marginVertical: 10,
})

const $changePasswordButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.palette.primary500,
  textDecorationLine: "underline",
})

const $passwordChangeContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  marginVertical: 20,
})

const $inputGroup: ThemedStyle<ViewStyle> = ({colors}) => ({
  marginBottom: 16,
})

const $inputLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "500",
  color: colors.palette.primary500,
  marginBottom: 8,
  fontFamily: "Montserrat-Medium",
})

const $enhancedInputContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  height: 48,
  borderWidth: 1,
  borderColor: colors.palette.primary500,
  borderRadius: 8,
})

const $enhancedInput: ThemedStyle<TextStyle> = ({colors}) => ({
  flex: 1,
  fontSize: 16,
  fontFamily: "Montserrat-Regular",
  color: colors.palette.primary500,
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
  backgroundColor: "#cccccc",
})

const $darkProfilePlaceholder: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: "#444444",
})

const $navigationBarContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
})

const $activeUpdatePasswordButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.palette.primary500,
})

const $disabledUpdatePasswordButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: "#cccccc",
})

const $updatePasswordButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.palette.neutral100,
  fontSize: 16,
  fontWeight: "bold",
})

const $inputIcon: ThemedStyle<ViewStyle> = ({colors}) => ({
  marginRight: 12,
})
