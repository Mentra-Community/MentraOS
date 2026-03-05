import {useRef, useState} from "react"
import {Pressable, ScrollView, TextInput, TouchableOpacity, View} from "react-native"

import {Button, Icon, Screen} from "@/components/ignite"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"
import {Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import composer from "@/services/Composer"
import Toast from "react-native-toast-message"
import {useLocalMiniApps} from "@/stores/applets"
import {useAppTheme} from "@/contexts/ThemeContext"
import BasicDialog from "@/components/ui/BasicDialog"

export default function MiniAppInstaller() {
  const viewShotRef = useRef<View>(null)
  const [url, setUrl] = useState("")
  const lmas = useLocalMiniApps()
  const {theme} = useAppTheme()
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false)
  const [versions, setVersions] = useState<string[]>([])
  const [packageName, setPackageName] = useState("")
  const [activeVersion, setActiveVersion] = useState("")

  const handleUninstall = async (packageName: string, version: string) => {
    let result = await composer.uninstallMiniApp(packageName, version)
    if (result.is_ok()) {
      Toast.show({type: "success", text1: "Mini app uninstalled successfully"})
    } else {
      Toast.show({type: "error", text1: "Failed to uninstall mini app"})
    }
  }

  const handleInstallMiniApp = async () => {
    console.log(`Installing MiniApp: ${url}`)
    let result = await composer.installMiniApp(url)
    console.log("result", result)
    if (result.is_ok()) {
      Toast.show({type: "success", text1: "Mini app installed successfully"})
    } else {
      Toast.show({type: "error", text1: "Failed to install mini app"})
    }
  }

  const showVersions = async (packageName: string) => {
    console.log(`Showing versions for ${packageName}`)
    const installedVersions: string[] = composer.getAppletInstalledVersions(packageName)
    const activeVersion = await composer.getActiveAppletVersion(packageName)
    // show all the versions, set the active
    setActiveVersion(activeVersion)
    setPackageName(packageName)
    setVersions(installedVersions)
    setVersionsDialogOpen(true)
  }

  const renderLmaList = () => {
    if (lmas.length === 0) {
      return (
        <View className="rounded-2xl bg-primary-foreground p-4">
          <Text className="text-center text-base font-medium" text="No local mini apps installed" />
        </View>
      )
    }
    return (
      <View className="gap-4 rounded-2xl bg-primary-foreground p-4">
        <Text className="text-xl font-semibold" text="Local Mini Apps" />
        {lmas.map((item, index) => (
          <TouchableOpacity
            onPress={() => showVersions(item.packageName)}
            key={`${item.packageName}-${item.version}-${index}`}
            className="flex-row items-center bg-background px-4 py-3 rounded-xl gap-3">
            <AppIcon app={item} style={{width: 48, height: 48}} />
            <View className="flex-1">
              <Text className="text-base font-medium" text={item.name} numberOfLines={1} />
              <Text className="text-sm text-gray-500" text={item.version} numberOfLines={1} />
            </View>
            {/* <Button
              preset="secondary"
              compactIcon
              onPress={() => handleUninstall(item.packageName)}
              hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
              <Icon name="trash" size={24} color={theme.colors.destructive} />
            </Button> */}
          </TouchableOpacity>
        ))}
      </View>
    )
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
      <MiniAppDualButtonHeader packageName="com.mentra.lma_installer" viewShotRef={viewShotRef} />
      {/* <View className="h-24" /> */}

      <ScrollView className="pt-20" contentContainerClassName="flex-grow">
        <View className="gap-12 p-6 rounded-2xl bg-primary-foreground">
          <Text tx="lmaInstaller:miniAppInstaller" className="text-xl font-semibold" />
          {/* url text input */}
          <View className="w-full bg-background h-10 items-center justify-center rounded-xl px-3">
            <TextInput
              hitSlop={{top: 16, bottom: 16}}
              className="text-base text-foreground text-md"
              placeholder="Enter URL"
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={false}
              keyboardType="url"
            />
          </View>
          <Button preset="primary" onPress={handleInstallMiniApp} text="Install Mini App" />
        </View>

        <View className="h-10" />

        {/* local mini apps list */}
        {renderLmaList()}
      </ScrollView>
      <View
        className={`absolute inset-0 justify-center items-center z-10 ${
          versionsDialogOpen ? "opacity-100" : "opacity-0"
        }`}>
        <Pressable
          className="flex-1 bg-black/50 absolute inset-0 -mx-20 -my-20"
          onPress={() => setVersionsDialogOpen(false)}
        />
        <View className="h-60 rounded-2xl bg-primary-foreground p-4 w-full">
          <Text className="text-xl font-semibold" tx="lmaInstaller:installedVersions" />
          <View className="flex-1 gap-3 mt-4">
            <ScrollView className="flex-1" contentContainerClassName="flex-grow">
              {versions.map((version) => (
                <TouchableOpacity
                  key={version}
                  className="flex-row items-center justify-between bg-background rounded-xl px-3 py-2">
                  <Text key={version} className="text-base font-medium" text={version} />
                  {activeVersion === version && <Text className="text-sm text-gray-500" text="Active" />}
                  <Button preset="secondary" compactIcon onPress={() => handleUninstall(packageName, version)}>
                    <Icon name="trash" size={24} color={theme.colors.destructive} />
                  </Button>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </View>
    </Screen>
  )
}
