import {useLocalSearchParams} from "expo-router"
import {useState, useEffect} from "react"
import {View, TextInput, TouchableOpacity} from "react-native"

import {EyeIcon} from "@/components/icons/EyeIcon"
import {EyeOffIcon} from "@/components/icons/EyeOffIcon"
import {WifiIcon} from "@/components/icons/WifiIcon"
import {Screen, Header, Checkbox, Button, Text} from "@/components/ignite"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {useGlassesStore} from "@/stores/glasses"
import showAlert from "@/utils/AlertUtils"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"
import {ConnectionOverlay} from "@/components/glasses/ConnectionOverlay"

export default function WifiPasswordScreen() {
  const params = useLocalSearchParams()
  const deviceModel = (params.deviceModel as string) || "Glasses"
  const initialSsid = (params.ssid as string) || ""
  const returnTo = params.returnTo as string | undefined
  const nextRoute = params.nextRoute as string | undefined

  const {theme} = useAppTheme()
  const {push, goBack, pushPrevious} = useNavigationHistory()
  const [ssid, setSsid] = useState(initialSsid)
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [rememberPassword, setRememberPassword] = useState(true)
  const [hasSavedPassword, setHasSavedPassword] = useState(false)

  // focusEffectPreventBack()

  useEffect(() => {
    if (initialSsid) {
      const savedPassword = WifiCredentialsService.getPassword(initialSsid)
      if (savedPassword) {
        setPassword(savedPassword)
        setHasSavedPassword(true)
        setRememberPassword(true)
      }
    }
  }, [initialSsid])

  useEffect(() => {
    if (!rememberPassword && initialSsid) {
      WifiCredentialsService.removeCredentials(initialSsid)
      setHasSavedPassword(false)
      console.log("$%^&*()_321321 removed credentials")
    }
  }, [rememberPassword, initialSsid])

  const handleConnect = async () => {
    if (!ssid) {
      showAlert(translate("common:error"), translate("wifi:pleaseEnterNetworkName"), [{text: translate("common:ok")}])
      return
    }

    if (!rememberPassword) {
      await WifiCredentialsService.removeCredentials(ssid)
    }

    push("/wifi/connecting", {
      deviceModel,
      ssid,
      password,
      rememberPassword: rememberPassword.toString(),
      returnTo,
      nextRoute,
    })
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("wifi:wifi")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ConnectionOverlay />

      <View className="bg-primary-foreground rounded-3xl p-6 w-full items-center mt-12">
        {/* WiFi Icon */}
        <View className="mb-3">
          <WifiIcon size={48} color={theme.colors.primary} />
        </View>

        <View className="gap-4 mt-6">
          {/* SSID Title */}
          <Text className="text-xl font-semibold text-text text-center mb-4">{ssid || "Enter Network Details"}</Text>

          {/* Manual entry shows SSID input */}
          {!initialSsid && (
            <View className="">
              <Text className="text-base text-text mb-2" tx="wifi:networkName" />
              <TextInput
                className="h-[50px] rounded-xl p-4 text-base text-foreground bg-background"
                value={ssid}
                onChangeText={setSsid}
                placeholder={translate("wifi:enterNetworkName")}
                placeholderTextColor={theme.colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          )}

          {/* Password input */}
          <View className="">
            <Text className="text-base text-text mb-2" tx="wifi:wifiPassword" />
            <View className="flex-row items-center relative">
              <TextInput
                className="flex-1 h-[50px] rounded-xl p-4 pr-[50px] text-base text-foreground bg-background"
                value={password}
                onChangeText={setPassword}
                placeholder="Enter password"
                placeholderTextColor={theme.colors.textDim}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => setShowPassword(!showPassword)}
                className="absolute right-3 h-[50px] w-10 justify-center items-center">
                {showPassword ? (
                  <EyeIcon size={24} color={theme.colors.textDim} />
                ) : (
                  <EyeOffIcon size={24} color={theme.colors.textDim} />
                )}
              </TouchableOpacity>
            </View>
            {hasSavedPassword && (
              <Text className="text-xs text-tint mt-2 italic" tx="wifi:passwordLoadedFromSavedCredentials" />
            )}
          </View>

          {/* Remember password checkbox */}
          <Checkbox
            value={rememberPassword}
            onValueChange={setRememberPassword}
            containerStyle={{width: "100%"}}
            labelPosition="right"
            label="Remember password"
            labelTx="wifi:rememberPassword"
            helper="Save password for future connections"
            helperTx="wifi:rememberPasswordDescription"
          />
        </View>

        <View className="w-full h-px bg-border mt-6 mb-6" />

        <View className="flex-row gap-3 w-full justify-end">
          <Button tx="common:cancel" onPress={goBack} preset="alternate" className="min-w-[100px]" />
          <Button tx="common:connect" onPress={handleConnect} className="min-w-[100px]" />
        </View>
      </View>
    </Screen>
  )
}
