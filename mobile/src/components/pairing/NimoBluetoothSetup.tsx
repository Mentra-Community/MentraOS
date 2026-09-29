import CrustModule from "@mentra/crust"
import {DeviceTypes, engine} from "@mentra/engine"
import {Image, ScrollView, View} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {DiscoveredGlassesRow} from "@/components/pairing/DiscoveredGlassesRow"
import {NimoHelp} from "@/components/pairing/NimoPreparation"
import {useNimoCompanionDiscovery} from "@/hooks/pairing/useNimoCompanionDiscovery"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"

export function NimoBluetoothSetup() {
  const {goBack, replace} = useNavigationStore.getState()
  const {devices, needsRetry, retry, select} = useNimoCompanionDiscovery((device) => {
    engine.pairing.markPendingSelection(DeviceTypes.NIMO)
    // The loading screen owns the actual connection and readiness handshake.
    replace("/pairing/loading", {device: JSON.stringify(device), deviceModel: device.model, deviceName: device.name})
  })
  const isMac = CrustModule.isIOSAppOnMac === true
  const openSettings = async () => {
    if (!(await SettingsNavigationUtils.openBluetoothSettings())) {
      showAlert(translate("common:error"), translate(isMac ? "pairing:nimoMacSettings" : "pairing:nimoSettings"))
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header
        title="NIMO"
        leftIcon="chevron-left"
        onLeftPress={goBack}
        RightActionComponent={<MentraLogoStandalone />}
      />
      <ScrollView contentContainerClassName="grow pt-6 pb-6" showsVerticalScrollIndicator={false}>
        <Text
          tx={devices.length > 1 ? "pairing:nimoChooseTitle" : "pairing:nimoConnectTitle"}
          className="text-3xl font-semibold text-foreground"
        />
        {devices.length > 1 ? (
          <View className="gap-2 mt-8">
            {devices.map((device) => (
              <DiscoveredGlassesRow
                key={device.id}
                title="NIMO"
                subtitle={device.name}
                onPress={() => select(device)}
              />
            ))}
          </View>
        ) : (
          <>
            <Text
              tx={isMac ? "pairing:nimoMacSettings" : "pairing:nimoSettings"}
              className="text-base leading-6 text-muted-foreground mt-3"
            />
            <View className="grow justify-center py-8">
              <Image
                source={
                  isMac
                    ? require("@assets/onboarding/nimo/bluetooth-mac.png")
                    : require("@assets/onboarding/nimo/bluetooth.png")
                }
                accessibilityLabel={translate("pairing:nimoSettingsImage")}
                resizeMode="contain"
                className="w-full rounded-2xl"
                style={{aspectRatio: isMac ? 2.37 : 1.67}}
              />
              <Text tx="pairing:nimoChooseMain" className="text-base leading-6 text-muted-foreground mt-6" />
            </View>
          </>
        )}
      </ScrollView>
      {needsRetry && <Button tx="pairing:scanAgain" preset="secondary" onPress={retry} className="mb-3" />}
      {devices.length < 2 && <Button tx="onboarding:openSettings" onPress={openSettings} />}
      <NimoHelp />
    </Screen>
  )
}
