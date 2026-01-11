import {useState} from "react"
import {View, TextInput, ActivityIndicator, ScrollView, TouchableOpacity} from "react-native"

import {Button, Header, Icon, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {mapAuthError} from "@/utils/auth/authErrors"

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const {goBack} = useNavigationHistory()
  const {theme} = useAppTheme()

  const isEmailValid = email.includes("@") && email.includes(".")

  const handleSendResetEmail = async () => {
    if (!isEmailValid) {
      showAlert(translate("common:error"), translate("login:invalidEmail"))
      return
    }

    setIsLoading(true)

    const res = await mentraAuth.resetPasswordForEmail(email)
    if (res.is_error()) {
      console.error("Error sending reset email:", res.error)
      showAlert(translate("common:error"), mapAuthError(res.error), [{text: translate("common:ok")}])
      setIsLoading(false)
      return
    }

    setIsLoading(false)

    // Show success alert and navigate back after dismissal
    showAlert(translate("login:resetEmailSent"), translate("login:checkEmailForReset"), [
      {text: translate("common:ok"), onPress: () => goBack()},
    ])
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("login:forgotPasswordTitle")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView className="flex-grow" showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View className="flex-1 p-4">
          <Text
            tx="login:forgotPasswordSubtitle"
            className="text-base text-secondary-foreground text-left mb-6 leading-[22px]"
          />

          <View className="w-full">
            <View className="mb-3">
              <Text tx="login:email" className="text-sm font-medium text-secondary-foreground mb-2" />
              <View className="flex-row items-center h-12 border border-border rounded-lg px-3 bg-background dark:bg-transparent dark:shadow-sm">
                <Icon name="mail" size={16} color={theme.colors.textDim} />
                <View className="w-3" />
                <TextInput
                  hitSlop={{top: 16, bottom: 16}}
                  className="flex-1 text-base text-secondary-foreground"
                  placeholder={translate("login:emailPlaceholder")}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholderTextColor={theme.colors.textDim}
                  autoFocus={true}
                />
              </View>
            </View>

            <View className="h-6" />

            <Button
              preset="primary"
              tx="login:sendResetEmail"
              onPress={handleSendResetEmail}
              disabled={!isEmailValid || isLoading}
              {...(isLoading && {
                LeftAccessory: () => (
                  <ActivityIndicator size="small" color={theme.colors.foreground} style={{marginRight: 8}} />
                ),
              })}
            />

            <View className="h-4" />

            <TouchableOpacity onPress={goBack} className="self-center mt-4">
              <Text tx="login:backToLogin" className="text-sm text-primary font-semibold" />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}
