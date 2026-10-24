/**
 * The declared-age question, the engine's `askDeclaredAge` seam. The Mentra App asks once, in its standard alert
 * sheet, when a miniapp rated above the app's own App Store rating first installs or opens and the person's Mentra
 * account has no age yet. The engine keeps the answer, with the date, on the account and never shares it with
 * miniapps.
 */
import {useEffect, useRef} from "react"
import {TextInput, View} from "react-native"

import {Text} from "@/components/ignite"
import {showAlert, waitForAlertHost} from "@/contexts/ModalContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"

/** Continue is the second button. */
const CONTINUE = 1
/** The ages a person may give, as Core keeps them. */
const MIN_AGE = 1
const MAX_AGE = 120
/** The keyboard opens once the sheet has slid in: a new sheet closes any keyboard that is already open. */
const FOCUS_DELAY_MS = 350

/** The age typed, as a whole number of years Core keeps, or null. */
export function parseDeclaredAge(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,3}$/.test(trimmed)) return null
  const age = Number(trimmed)
  return age >= MIN_AGE && age <= MAX_AGE ? age : null
}

function AgeField({initial, invalid, onChange}: {initial: string; invalid: boolean; onChange: (text: string) => void}) {
  const {theme} = useAppTheme()
  const input = useRef<TextInput>(null)

  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <View className="items-center gap-2">
      <TextInput
        ref={input}
        defaultValue={initial}
        onChangeText={onChange}
        keyboardType="number-pad"
        maxLength={3}
        placeholder={translate("miniappAge:agePlaceholder")}
        placeholderTextColor={theme.colors.muted_foreground}
        accessibilityLabel={translate("miniappAge:agePlaceholder")}
        className="h-14 w-36 rounded-2xl bg-primary-foreground px-4 text-center text-[22px]"
        style={{color: theme.colors.foreground}}
        testID="declaredAge.input"
      />
      {invalid && (
        <Text
          text={translate("miniappAge:invalidAge")}
          className="text-center text-sm text-destructive"
          testID="declaredAge.invalid"
        />
      )}
    </View>
  )
}

/**
 * Ask the person how old they are. Resolves the whole number of years they give, or null when they cancel. An
 * answer that isn't an age asks again, saying why.
 */
export async function askDeclaredAge(): Promise<number | null> {
  // At startup the sheet may not be mounted yet; the question waits for it rather than counting as cancelled.
  await waitForAlertHost()
  let text = ""
  let invalid = false
  for (;;) {
    const answer = await showAlert({
      title: translate("miniappAge:askTitle"),
      message: translate("miniappAge:askMessage"),
      buttons: [{text: translate("common:cancel"), style: "cancel"}, {text: translate("miniappAge:continue")}],
      options: {
        allowDismiss: true,
        content: (
          <AgeField
            initial={text}
            invalid={invalid}
            onChange={(value) => {
              text = value
            }}
          />
        ),
      },
    })
    if (answer !== CONTINUE) return null
    const age = parseDeclaredAge(text)
    if (age !== null) return age
    invalid = true
  }
}
