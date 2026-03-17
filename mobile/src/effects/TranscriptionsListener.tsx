import {memo, useEffect, useMemo, useRef, useState} from "react"
import {View} from "react-native"
import {useLocalMiniApps} from "@/stores/applets"
import LocalMiniApp from "@/components/home/LocalMiniApp"
import composer from "@/services/Composer"
import {usePathname} from "expo-router"
import {Screen} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"
import * as SpeechTranscriber from "expo-speech-transcriber"

function TranscriptionsListener() {
  const {text, isFinal, error} = SpeechTranscriber.useRealTimeTranscription()

  const lmas = useLocalMiniApps()
  const pathname = usePathname()
  const viewShotRef = useRef<View>(null)
  const [packageName, setPackageName] = useState<string | null>(null)
  const {getCurrentParams} = useNavigationHistory()

  useEffect(() => {
    if (text) {
      console.log("TranscriptionsListener: ", text)
      // notify the composer of the transcription:
      // composer.feedLocalTranscription(text)
    }
  }, [text])

  return null
}

export default TranscriptionsListener
