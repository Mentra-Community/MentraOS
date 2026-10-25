/**
 * The install sheet (spec, "Installing"): the Mentra App's standard alert sheet, never a native alert. It shows the
 * miniapp's icon, its name and age rating, and where it comes from: "From notes.example.com", the miniapp URL's own
 * host, or "From your local network" with the address. Install and Cancel; a swipe, a tap outside and Android back
 * all mean Cancel, so nothing installs without the person pressing Install.
 */
import type {MiniappInstallPreview} from "@mentra/engine"
import {Image} from "expo-image"
import {useState} from "react"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import {showAlert, waitForAlertHost, type AlertButton} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

const ICON_SIZE = 56

/** The miniapp's icon from its `miniapp.json`, or its initial on a tile when it has none or it doesn't load. */
export function MiniappInstallIcon({iconUrl, name}: {iconUrl: string | null; name: string}) {
  const [failed, setFailed] = useState(false)
  if (iconUrl && !failed) {
    return (
      <Image
        source={{uri: iconUrl}}
        style={{width: ICON_SIZE, height: ICON_SIZE, borderRadius: 13}}
        contentFit="cover"
        accessibilityIgnoresInvertColors
        onError={() => setFailed(true)}
        testID="miniappInstall.icon"
      />
    )
  }
  return (
    <View
      className="items-center justify-center rounded-2xl bg-primary-foreground"
      style={{width: ICON_SIZE, height: ICON_SIZE}}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="miniappInstall.iconTile">
      <Text
        text={name.trim().charAt(0).toUpperCase()}
        weight="semibold"
        className="text-2xl text-secondary-foreground"
      />
    </View>
  )
}

/** The address a local-network miniapp's sheet names: its host and port. */
export function localMiniappAddress(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * The sheet's title and message for a miniapp. `installedName`: the name of the copy installed now, which the replace
 * line names (a development build of the package can carry another name); the miniapp's own name when unknown.
 */
export function miniappInstallSheetCopy(
  preview: MiniappInstallPreview,
  installedName?: string | null,
): {title: string; message: string} {
  const title = preview.ageRating
    ? translate("miniappInstall:nameWithRating", {name: preview.name, rating: preview.ageRating})
    : preview.name
  const from = preview.local
    ? translate("miniappInstall:fromLocalNetwork", {address: localMiniappAddress(preview.url)})
    : translate("miniappInstall:from", {host: preview.host})
  const message = preview.alreadyInstalled
    ? `${from}\n\n${translate("miniappInstall:replaces", {name: installedName?.trim() || preview.name})}`
    : from
  return {title, message}
}

type SheetChoice = "cancel" | "install"

/**
 * Ask the person whether to install the miniapp. Resolves true only when they press Install. `installedName` names
 * the copy it replaces, when one is installed. The sheet answers with the pressed button's index, and lays buttons
 * out by their style, so each button carries its role.
 */
export async function confirmMiniappInstall(
  preview: MiniappInstallPreview,
  installedName?: string | null,
): Promise<boolean> {
  const choices: Array<{role: SheetChoice; button: AlertButton}> = [
    {role: "cancel", button: {text: translate("common:cancel"), style: "cancel"}},
    {role: "install", button: {text: translate("miniappInstall:install")}},
  ]
  // A link that cold-starts the app arrives before the sheet is mounted; with no sheet, the answer would be no.
  await waitForAlertHost()
  const {title, message} = miniappInstallSheetCopy(preview, installedName)
  const index = await showAlert({
    title,
    message,
    buttons: choices.map(({button}) => button),
    options: {icon: <MiniappInstallIcon iconUrl={preview.iconUrl} name={preview.name} />, allowDismiss: true},
  })
  return choices[index]?.role === "install"
}
