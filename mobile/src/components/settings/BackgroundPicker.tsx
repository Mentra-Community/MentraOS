import {Image} from "expo-image"
import * as ImagePicker from "expo-image-picker"
import {Directory, Paths, File} from "expo-file-system"
import {TouchableOpacity, View} from "react-native"

import {Icon} from "@/components/ignite"
import {Text} from "@/components/ignite"
import {Group} from "@/components/ui/Group"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {translate} from "@/i18n"

const PRESET_BACKGROUNDS = [
  "https://mentra-wallpapers.mentraglass.com/landscape1.jpeg",
  "https://mentra-wallpapers.mentraglass.com/landscape2.jpeg",
  "https://mentra-wallpapers.mentraglass.com/landscape3.jpeg",
  "https://mentra-wallpapers.mentraglass.com/trees.jpg",
  "https://mentra-wallpapers.mentraglass.com/clouds.jpeg",
  "https://mentra-wallpapers.mentraglass.com/firewatch.jpg",
]

async function saveBackgroundImage(uri: string): Promise<string> {
  const bgDir = new Directory(Paths.document, "backgrounds")
  if (!bgDir.exists) {
    bgDir.create()
  }
  const filename = `bg_${Date.now()}.jpg`
  const source = new File(uri)
  source.copy(new File(bgDir, filename))
  return new File(bgDir, filename).uri
}

export default function BackgroundPicker() {
  const {theme} = useAppTheme()
  const [background, setBackground] = useSetting<string>(SETTINGS.home_background.key)

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      allowsMultipleSelection: false,
    })

    if (!result.canceled && result.assets[0]) {
      const savedUri = await saveBackgroundImage(result.assets[0].uri)
      await setBackground(savedUri)
    }
  }

  const selectPreset = async (uri: string) => {
    if (background === uri) return
    await setBackground(uri)
  }

  const clearBackground = async () => {
    await setBackground("")
  }

  const isSelected = (uri: string) => background === uri
  const isCustom = background && !PRESET_BACKGROUNDS.includes(background)

  return (
    <Group title={translate("appearanceSettings:homeBackground")}>
      <View className="flex-row flex-wrap gap-3">
        {/* None option */}
        <TouchableOpacity onPress={clearBackground} className="items-center w-[72px]">
          <View
            className={`w-[72px] h-[72px] rounded-lg overflow-hidden items-center justify-center border-2 border-dashed border-border ${
              !background ? "border-solid border-[3px]" : ""
            }`}
            style={!background ? {borderColor: theme.colors.tint} : undefined}>
            <Icon name="x" size={24} color={theme.colors.text} />
          </View>
          <Text className="text-[10px] mt-1 text-center">{translate("appearanceSettings:noBackground")}</Text>
        </TouchableOpacity>

        {/* Presets */}
        {PRESET_BACKGROUNDS.map((uri) => (
          <TouchableOpacity key={uri} onPress={() => selectPreset(uri)} className="items-center w-[72px]">
            <View
              className="w-[72px] h-[72px] rounded-lg overflow-hidden border-[3px]"
              style={{borderColor: isSelected(uri) ? theme.colors.tint : "transparent"}}>
              <Image source={{uri}} style={{width: "100%", height: "100%"}} contentFit="cover" />
            </View>
          </TouchableOpacity>
        ))}

        {/* Pick from library */}
        <TouchableOpacity onPress={pickImage} className="items-center w-[72px]">
          <View
            className={`w-[72px] h-[72px] rounded-lg overflow-hidden items-center justify-center ${
              isCustom ? "border-solid border-[3px]" : "border-2 border-dashed border-border"
            }`}
            style={isCustom ? {borderColor: theme.colors.tint} : undefined}>
            {isCustom ? (
              <Image source={{uri: background}} style={{width: "100%", height: "100%"}} contentFit="cover" />
            ) : (
              <Icon name="plus" size={24} color={theme.colors.text} />
            )}
          </View>
          <Text className="text-[10px] mt-1 text-center">{translate("appearanceSettings:chooseFromLibrary")}</Text>
        </TouchableOpacity>
      </View>
    </Group>
  )
}
