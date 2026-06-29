import {Screen} from "@/components/ignite"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {SETTINGS, useSetting} from "@/stores/settings"

export default function AuthCallback() {
  const [appBootExtraInfo] = useSetting(SETTINGS.app_boot_extra_info.key)

  return (
    <Screen preset="fixed">
      <SplashVideo label={appBootExtraInfo ? "Finishing sign-in…" : undefined} />
    </Screen>
  )
}
