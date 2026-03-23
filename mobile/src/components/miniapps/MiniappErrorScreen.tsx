import {useEffect, useState} from "react"
import {TouchableOpacity, View} from "react-native"

import AppIcon from "@/components/home/AppIcon"
import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import restComms from "@/services/RestComms"
import {useAppletStatusStore} from "@/stores/applets"

interface MiniappErrorScreenProps {
  packageName: string
  appName: string
  message?: string
  onRetry: () => void
}

interface DeveloperInfo {
  name?: string
  contactEmail?: string
  website?: string
}

export default function MiniappErrorScreen({packageName, appName, message, onRetry}: MiniappErrorScreenProps) {
  const {theme} = useAppTheme()
  const [developerInfo, setDeveloperInfo] = useState<DeveloperInfo | null>(null)

  const app = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)

  useEffect(() => {
    const fetchDeveloperInfo = async () => {
      const res = await restComms.getAppSettings(packageName)
      if (!res.is_error() && res.value?.organization) {
        const org = res.value.organization
        if (org.name || org.contactEmail) {
          setDeveloperInfo({
            name: org.name,
            contactEmail: org.contactEmail,
            website: org.website,
          })
        }
      }
    }
    fetchDeveloperInfo()
  }, [packageName])

  const errorMessage = message || `Something went wrong while loading ${appName}. Please try again.`

  const developerLine = (() => {
    if (!developerInfo) return null
    const name = developerInfo.name
    const contact = developerInfo.contactEmail || developerInfo.website
    if (name && contact) {
      return `If this keeps happening, contact the miniapp's developer "${name}" at ${contact}.`
    }
    if (name) {
      return `If this keeps happening, contact the miniapp's developer "${name}".`
    }
    if (contact) {
      return `If this keeps happening, contact the miniapp's developer at ${contact}.`
    }
    return null
  })()

  return (
    <View className="flex-1 items-center justify-center px-8">
      {/* App icon, dimmed */}
      {app && (
        <View className="opacity-40 mb-6">
          <AppIcon app={{...app, loading: false}} style={{width: 80, height: 80, borderRadius: theme.spacing.s5}} />
        </View>
      )}

      <Text
        style={{
          fontSize: 20,
          fontWeight: "600",
          fontFamily: "Montserrat-Bold",
          color: theme.colors.text,
          textAlign: "center",
          marginBottom: theme.spacing.s3,
        }}>
        {`Can't connect to ${appName}`}
      </Text>

      <Text
        style={{
          fontSize: 15,
          fontFamily: "Montserrat-Regular",
          color: theme.colors.textDim,
          textAlign: "center",
          lineHeight: 22,
          marginBottom: theme.spacing.s2,
        }}>
        {errorMessage}
      </Text>

      {developerLine && (
        <Text
          style={{
            fontSize: 13,
            fontFamily: "Montserrat-Regular",
            color: theme.colors.textDim,
            textAlign: "center",
            lineHeight: 20,
            marginBottom: theme.spacing.s2,
          }}>
          {developerLine}
        </Text>
      )}

      {/* <TouchableOpacity
        onPress={onRetry}
        style={{
          marginTop: theme.spacing.s6,
          backgroundColor: theme.colors.primary,
          borderRadius: 8,
          paddingHorizontal: 24,
          paddingVertical: 12,
        }}>
        <Text
          style={{
            fontSize: 16,
            fontWeight: "600",
            color: theme.colors.palette.neutral100,
          }}>
          Retry
        </Text>
      </TouchableOpacity> */}
    </View>
  )
}
