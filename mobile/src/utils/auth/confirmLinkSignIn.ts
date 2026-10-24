import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"
import type {LinkSignInAccount} from "@/utils/auth/authProvider.types"

/**
 * Asks before an email link signs the phone in to an account it didn't start signing up for, naming that account and
 * the one signed in now. Only an explicit "Sign in" accepts; dismissing it, or no alert host, declines.
 */
export async function confirmLinkSignIn({email, current}: LinkSignInAccount): Promise<boolean> {
  const message = !current
    ? translate("login:linkSignInMessage", {email})
    : current.email
      ? translate("login:linkSignInSwitchMessage", {email, current: current.email})
      : translate("login:linkSignInSwitchUnknownMessage", {email})
  const answer = await showAlert({
    title: translate("login:linkSignInTitle"),
    message,
    buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("login:linkSignInContinue")}],
    options: {allowDismiss: true},
  })
  return answer === 1
}
