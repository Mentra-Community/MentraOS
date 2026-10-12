import {useState} from "react"
import {Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {Button, Text} from "@/components/ignite"

export function NimoHelp() {
  const [visible, setVisible] = useState(false)
  return (
    <>
      <TouchableOpacity accessibilityRole="button" className="items-center py-4" onPress={() => setVisible(true)}>
        <Text tx="pairing:nimoNeedHelp" className="text-sm text-muted-foreground" />
      </TouchableOpacity>
      <GlassesTroubleshootingModal isVisible={visible} onClose={() => setVisible(false)} deviceModel="NIMO" />
    </>
  )
}

export function NimoPreparation({onContinue}: {onContinue: () => Promise<void>}) {
  const [busy, setBusy] = useState(false)
  const handleContinue = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onContinue()
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="flex-1">
      <ScrollView contentContainerClassName="grow pt-6 pb-6" showsVerticalScrollIndicator={false}>
        <Text tx="pairing:nimoOpenTitle" className="text-3xl font-semibold text-foreground" />
        <Text tx="pairing:nimoOpenBody" className="text-base leading-6 text-muted-foreground mt-3" />
        <View className="grow justify-center py-8">
          <View className="rounded-3xl bg-primary/10 px-6 py-16">
            <Image source={require("@assets/glasses/nimo.png")} resizeMode="contain" className="w-full h-36" />
          </View>
        </View>
      </ScrollView>
      <Button
        tx={Platform.OS === "ios" ? "pairing:nimoTheyreOpen" : "pairing:nimoFindGlasses"}
        onPress={handleContinue}
        disabled={busy}
      />
      <NimoHelp />
    </View>
  )
}
