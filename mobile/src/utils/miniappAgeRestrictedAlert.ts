import type {AgeRestrictionNotice} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

/** The engine's age gate stopped a miniapp the person was installing or opening (`showAgeRestricted`). */
export function showMiniappAgeRestrictedAlert(notice: AgeRestrictionNotice): void {
  const name = notice.name || notice.packageName
  void showAlert(
    notice.reason === "too_young"
      ? {
          title: translate("miniappAge:restrictedTitle", {name, rating: notice.ageRating}),
          message: translate("miniappAge:restrictedMessage"),
          buttons: [{text: translate("common:ok")}],
        }
      : {
          title: translate("miniappAge:unavailableTitle"),
          message: translate("miniappAge:unavailableMessage"),
          buttons: [{text: translate("common:ok")}],
        },
  )
}
