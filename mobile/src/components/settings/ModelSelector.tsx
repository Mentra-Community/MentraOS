import {useState} from "react"
import {
  View,
  TouchableOpacity,
  Modal,
  FlatList,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
} from "react-native"

import {Icon, Text, Button} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {ModelInfo, STTModelManager} from "@/services/STTModelManager"
import {DownloadState} from "@/stores/modelDownload"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type ModelSelectorProps = {
  selectedModelId: string
  models: ModelInfo[]
  onModelChange: (modelId: string) => void
  onDownload: (modelId: string) => void
  onDelete: (modelId: string) => void
  onCancelDownload: () => void
  isDownloading: boolean
  downloadingModelId: string | null
  downloadProgress: number
  extractionProgress: number
  downloadState: DownloadState
  currentModelInfo: ModelInfo | null
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModelId,
  models,
  onModelChange,
  onDownload,
  onDelete: _onDelete,
  onCancelDownload,
  isDownloading,
  downloadingModelId,
  downloadProgress,
  extractionProgress,
  downloadState,
  currentModelInfo: _currentModelInfo,
}) => {
  const {theme, themed} = useAppTheme()
  const [modalVisible, setModalVisible] = useState(false)

  const selectedModel = models.find(m => m.modelId === selectedModelId)
  const isDownloaded = selectedModel?.downloaded || false

  // Check if this specific model is being downloaded
  const isThisModelDownloading = isDownloading && downloadingModelId === selectedModelId

  const getStatusIcon = () => {
    if (isThisModelDownloading) {
      return <ActivityIndicator size="small" color={theme.colors.foreground} />
    }
    return null
  }

  const getSubtitle = () => {
    if (!selectedModel) return ""

    if (isThisModelDownloading) {
      if (downloadState === "activating") {
        return "Activating model..."
      } else if (downloadState === "extracting" || extractionProgress > 0) {
        return `Extracting... ${extractionProgress}%`
      } else if (downloadState === "downloading" || downloadProgress > 0) {
        return `Downloading... ${downloadProgress}%`
      } else {
        return "Preparing download..."
      }
    }

    const sizeText = STTModelManager.formatBytes(selectedModel.size)
    if (isDownloaded) {
      return `${sizeText} • Downloaded`
    }
    return `${sizeText} • Not downloaded`
  }

  const renderModelOption = ({item}: {item: ModelInfo}) => {
    const isSelected = item.modelId === selectedModelId
    const isModelDownloaded = item.downloaded
    const isModelBeingDownloaded = isDownloading && downloadingModelId === item.modelId

    return (
      <Pressable
        style={themed($optionItem)}
        onPress={() => {
          onModelChange(item.modelId)
          setModalVisible(false)
        }}>
        <View style={themed($optionContent)}>
          <View style={themed($optionTextContainer)}>
            <Text
              text={item.name}
              style={[
                themed($optionText),
                {
                  fontWeight: isSelected ? "600" : "400",
                },
              ]}
            />
            <Text
              text={
                isModelBeingDownloaded
                  ? `Downloading... ${downloadProgress}%`
                  : `${STTModelManager.formatBytes(item.size)}${isModelDownloaded ? " • Downloaded" : ""}`
              }
              style={themed($optionSubtext)}
            />
          </View>
          <View style={themed($optionIcons)}>
            {isModelBeingDownloaded && <ActivityIndicator size="small" color={theme.colors.foreground} />}
            {isSelected && !isModelBeingDownloaded && <Icon name="check" size={24} color={theme.colors.foreground} />}
          </View>
        </View>
      </Pressable>
    )
  }

  return (
    <View style={themed($container)}>
      <Group title="Offline Mode Speech Model">
        <TouchableOpacity style={themed($selector)} onPress={() => setModalVisible(true)} activeOpacity={0.7}>
          <View style={themed($selectorContent)}>
            <View style={themed($selectorTextContainer)}>
              <Text text={selectedModel?.name || "Select..."} style={themed($selectedText)} />
              <Text text={getSubtitle()} style={themed($subtitleText)} />
            </View>
            <View style={themed($selectorIcons)}>
              {getStatusIcon()}
              <Icon
                name="chevron-down"
                size={20}
                color={theme.colors.foreground}
                style={{marginLeft: theme.spacing.s2}}
              />
            </View>
          </View>
        </TouchableOpacity>
      </Group>

      {/* Download button for current selection */}
      {selectedModel && !isDownloaded && !isThisModelDownloading && (
        <Button
          preset="primary"
          text="Download Model"
          onPress={() => onDownload(selectedModelId)}
          style={{marginTop: theme.spacing.s4}}
          LeftAccessory={() => <Icon name="download" size={20} color={theme.colors.primary_foreground} />}
        />
      )}

      {/* Cancel button when downloading */}
      {isThisModelDownloading && (
        <Button
          preset="default"
          text="Cancel Download"
          onPress={onCancelDownload}
          style={{marginTop: theme.spacing.s4}}
          LeftAccessory={() => <Icon name="x" size={20} color={theme.colors.foreground} />}
        />
      )}

      <Modal
        visible={modalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
          <TouchableWithoutFeedback onPress={() => setModalVisible(false)}>
            <View style={themed($modalOverlay)}>
              <TouchableWithoutFeedback>
                <View style={themed($modalContent)}>
                  <View style={themed($modalHeader)}>
                    <Text text="Select Model" style={themed($modalLabel)} />
                  </View>
                  <FlatList
                    data={models}
                    keyExtractor={item => item.modelId}
                    renderItem={renderModelOption}
                    style={themed($optionsList)}
                    contentContainerStyle={{paddingBottom: theme.spacing.s4}}
                  />
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  width: "100%",
})

const $selector: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  backgroundColor: colors.primary_foreground,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
})

const $selectorContent: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $selectorTextContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $selectedText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
})

const $subtitleText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  marginTop: 2,
  color: colors.textDim,
})

const $selectorIcons: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
})

const $modalOverlay: ThemedStyle<ViewStyle> = ({colors}) => ({
  alignItems: "center",
  backgroundColor: colors.background + "60",
  flex: 1,
  justifyContent: "center",
})

const $modalContent: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  elevation: 5,
  maxHeight: "70%",
  shadowColor: "#000",
  shadowOffset: {width: 0, height: 2},
  shadowOpacity: 0.2,
  width: "90%",
  backgroundColor: colors.primary_foreground,
  borderColor: colors.border,
  borderWidth: 1,
  borderRadius: spacing.s4,
  shadowRadius: spacing.s2,
  overflow: "hidden",
})

const $modalHeader: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
  marginBottom: spacing.s3,
  padding: spacing.s6,
})

const $modalLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
})

const $optionsList: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexGrow: 0,
  maxHeight: 400,
  backgroundColor: colors.primary_foreground,
})

const $optionItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  width: "100%",
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s6,
})

const $optionContent: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $optionTextContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $optionText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
})

const $optionSubtext: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  marginTop: 2,
  color: colors.textDim,
})

const $optionIcons: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
})

export default ModelSelector
