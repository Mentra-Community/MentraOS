import {useState, useMemo, useCallback, FC} from "react"
import {View, TouchableOpacity, ViewStyle, TextStyle, Modal, ScrollView, TextInput, Platform} from "react-native"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

import {Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {Group} from "@/components/ui/Group"
import {translate} from "@/i18n"
import {ClientAppletInterface} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface AppPickerProps {
  visible: boolean
  onClose: () => void
  onSelect: (app: ClientAppletInterface) => void
  apps: ClientAppletInterface[]
  selectedPackageName?: string
  title?: string
  filterPredicate?: (app: ClientAppletInterface) => boolean
  showCompatibilityWarnings?: boolean
}

/**
 * AppPicker Component
 *
 * A reusable modal for selecting apps with search, filtering, and compatibility warnings.
 *
 * @param visible - Whether the modal is visible
 * @param onClose - Callback when modal is closed
 * @param onSelect - Callback when an app is selected
 * @param apps - Array of apps to display
 * @param selectedPackageName - Currently selected app package name
 * @param title - Modal title (default: "Select App")
 * @param filterPredicate - Optional filter function to show only certain apps
 * @param showCompatibilityWarnings - Whether to show compatibility warnings (default: true)
 */
export const AppPicker: FC<AppPickerProps> = ({
  visible,
  onClose,
  onSelect,
  apps,
  selectedPackageName,
  title = "Select App",
  filterPredicate,
  showCompatibilityWarnings = true,
}) => {
  const {themed, theme} = useAppTheme()
  const [searchQuery, setSearchQuery] = useState("")

  // // Debug logging when modal opens
  // useEffect(() => {
  //   if (visible) {
  //     console.log("🔍 AppPicker opened with", apps.length, "total apps")
  //     console.log("🔍 Filter predicate exists:", !!filterPredicate)
  //     if (filterPredicate) {
  //       const filtered = apps.filter(filterPredicate)
  //       console.log("🔍 After filter predicate:", filtered.length, "apps")
  //       console.log(
  //         "🔍 Filtered apps:",
  //         filtered.map(a => ({name: a.name, type: a.type, compatible: a.compatibility?.isCompatible})),
  //       )
  //     }
  //   }
  // }, [visible, apps, filterPredicate])

  // Filter and search apps
  const filteredApps = useMemo(() => {
    let result = apps

    // Apply custom filter predicate if provided
    if (filterPredicate) {
      result = result.filter(filterPredicate)
    }

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      result = result.filter(
        app => app.name.toLowerCase().includes(query) || app.packageName.toLowerCase().includes(query),
      )
    }

    // Sort: compatible first, then alphabetically by name
    return result.sort((a, b) => {
      // Compatible apps first
      const aCompatible = a.compatibility?.isCompatible !== false
      const bCompatible = b.compatibility?.isCompatible !== false

      if (aCompatible !== bCompatible) {
        return aCompatible ? -1 : 1
      }

      // Then alphabetically
      return a.name.localeCompare(b.name)
    })
  }, [apps, searchQuery, filterPredicate])

  const handleAppPress = useCallback(
    (app: ClientAppletInterface) => {
      onSelect(app)
      onClose()
      setSearchQuery("") // Reset search
    },
    [onSelect, onClose],
  )

  const handleClose = useCallback(() => {
    setSearchQuery("") // Reset search
    onClose()
  }, [onClose])

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={handleClose}>
      <View style={themed($modalOverlay)}>
        <View style={themed($modalContent)}>
          {/* Header */}
          <View style={themed($header)}>
            <Text text={title} style={themed($title)} />
            <TouchableOpacity onPress={handleClose} style={themed($closeButton)}>
              <MaterialCommunityIcons name="close" size={24} color={theme.colors.text} />
            </TouchableOpacity>
          </View>

          {/* Search Bar */}
          <View style={themed($searchContainer)}>
            <MaterialCommunityIcons name="magnify" size={20} color={theme.colors.textDim} style={themed($searchIcon)} />
            <TextInput
              style={themed($searchInput)}
              placeholder="Search"
              placeholderTextColor={theme.colors.textDim}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery("")} style={themed($clearButton)}>
                <MaterialCommunityIcons name="close-circle" size={20} color={theme.colors.textDim} />
              </TouchableOpacity>
            )}
          </View>

          {/* App List */}
          <ScrollView style={themed($scrollView)} contentContainerStyle={themed($scrollContent)}>
            {/* Debug text */}
            <Text style={{color: theme.colors.text, padding: 10}}>Showing {filteredApps.length} apps</Text>

            <Group>
              {filteredApps.length === 0 ? (
                <View style={themed($emptyState)}>
                  <MaterialCommunityIcons name="application-outline" size={48} color={theme.colors.textDim} />
                  <Text
                    text={searchQuery ? translate("common:noResults") : translate("common:noApps")}
                    style={themed($emptyText)}
                  />
                </View>
              ) : (
                filteredApps.map(app => {
                  const isSelected = app.packageName === selectedPackageName
                  const isCompatible = app.compatibility?.isCompatible !== false
                  const compatibilityMessage = app.compatibility?.message || ""
                  const isOffline = app.offline

                  return (
                    <TouchableOpacity
                      key={app.packageName}
                      style={themed($appItem)}
                      onPress={() => handleAppPress(app)}
                      disabled={!isCompatible && showCompatibilityWarnings}>
                      <View style={themed($appItemContent)}>
                        <AppIcon app={app} style={themed($appIconSmall)} />
                        <View style={themed($appInfo)}>
                          <View style={themed($appNameRow)}>
                            <Text text={app.name} style={themed($appName)} numberOfLines={1} />
                            {isOffline && (
                              <View style={[themed($badge), {backgroundColor: theme.colors.success}]}>
                                <MaterialCommunityIcons name="home" size={12} color={theme.colors.palette.white} />
                              </View>
                            )}
                            {isSelected && (
                              <MaterialCommunityIcons name="check-circle" size={20} color={theme.colors.success} />
                            )}
                          </View>
                          {!isCompatible && showCompatibilityWarnings && compatibilityMessage && (
                            <View style={themed($warningContainer)}>
                              <MaterialCommunityIcons name="alert-circle" size={14} color={theme.colors.error} />
                              <Text text={compatibilityMessage} style={themed($warningText)} numberOfLines={2} />
                            </View>
                          )}
                        </View>
                      </View>
                    </TouchableOpacity>
                  )
                })
              )}
            </Group>
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

// Styles
const $modalOverlay: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  backgroundColor: "rgba(0, 0, 0, 0.5)",
  justifyContent: "flex-end",
})

const $modalContent: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderTopLeftRadius: spacing.s6,
  borderTopRightRadius: spacing.s6,
  height: "90%", // Changed from maxHeight to height for consistent sizing
  paddingBottom: Platform.OS === "ios" ? spacing.s8 : spacing.s6,
})

const $header: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  padding: spacing.s6,
  paddingBottom: spacing.s4,
})

const $title: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.text,
  flex: 1,
})

const $closeButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s2,
})

const $searchContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s3,
  marginHorizontal: spacing.s6,
  marginBottom: spacing.s4,
  paddingHorizontal: spacing.s3,
})

const $searchIcon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginRight: spacing.s2,
})

const $searchInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
  paddingVertical: spacing.s3,
})

const $clearButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s2,
})

const $scrollView: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  minHeight: 400, // Ensure minimum height for scrollview
})

const $scrollContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s6,
  paddingBottom: spacing.s6,
  flexGrow: 1, // Ensure content can grow
})

const $emptyState: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: spacing.s12,
})

const $emptyText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  color: colors.textDim,
  marginTop: spacing.s4,
})

const $appItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s3,
  padding: spacing.s3,
  minHeight: 70, // Ensure minimum height
})

const $appItemContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s3,
})

const $appIconSmall: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: spacing.s12,
  height: spacing.s12,
})

const $appInfo: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $appNameRow: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s2,
})

const $appName: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
  flex: 1,
})

const $badge: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.secondary400,
  borderRadius: spacing.s2,
  padding: spacing.s1,
  paddingHorizontal: spacing.s2,
})

const $warningContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "flex-start",
  marginTop: spacing.s2,
  gap: spacing.s2,
  backgroundColor: colors.backgroundAlt,
  padding: spacing.s2,
  borderRadius: spacing.s2,
})

const $warningText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.error,
  flex: 1,
})
