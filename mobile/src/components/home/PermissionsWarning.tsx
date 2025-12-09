import {useFocusEffect} from "@react-navigation/native"
import NotificationOn from "assets/icons/component/NotificationOn"
import {useCallback, useState} from "react"
import {Platform, TouchableOpacity} from "react-native"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {checkFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"
// import {Icon} from "@/components/ignite"

export default function PermissionsWarning() {
  const [hasMissingPermissions, setHasMissingPermissions] = useState(false)
  const {push} = useNavigationHistory()
  // const {theme} = useAppTheme()

  const handleBellPress = () => {
    push("/settings/privacy")
  }

  const checkPermissions = async () => {
    const hasCalendar = await checkFeaturePermissions(PermissionFeatures.CALENDAR)
    const hasNotifications =
      Platform.OS === "android" ? await checkFeaturePermissions(PermissionFeatures.READ_NOTIFICATIONS) : true

    const hasLocation = await checkFeaturePermissions(PermissionFeatures.BACKGROUND_LOCATION)

    const shouldShowBell = !hasCalendar || !hasNotifications || !hasLocation
    setHasMissingPermissions(shouldShowBell)
  }

  // check for permissions when the screen is focused:
  useFocusEffect(
    useCallback(() => {
      checkPermissions()
    }, []),
  )

  return (
    <>
      {hasMissingPermissions && (
        <TouchableOpacity onPress={handleBellPress}>
          <NotificationOn />
          {/* <Icon name="bell" size={24} color={theme.colors.icon} /> */}
        </TouchableOpacity>
      )}
    </>
  )
}
