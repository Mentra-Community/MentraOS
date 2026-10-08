import {SignedMiniappDevBuildError} from "@mentra/engine-host-internal"

import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

/**
 * Alert copy for a dev build the phone refused or could not register. A package
 * installed with a publisher signature refuses unsigned dev code until the user
 * uninstalls it, so that case names the package and the fix.
 */
export function devBuildErrorAlert(error: unknown): {title: string; message: string} {
  if (error instanceof SignedMiniappDevBuildError) {
    return {
      title: translate("debugSettings:miniappDevSignedInstallTitle"),
      message: translate("debugSettings:miniappDevSignedInstallBody", {packageName: error.packageName}),
    }
  }
  return {
    title: translate("debugSettings:miniappDevLoadErrorTitle"),
    message: error instanceof Error ? error.message : String(error),
  }
}

export function showDevBuildError(error: unknown, onDismiss?: () => void): void {
  const {title, message} = devBuildErrorAlert(error)
  showAlert(title, message, [{text: translate("common:ok"), onPress: onDismiss}])
}
