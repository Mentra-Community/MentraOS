import {memo, useEffect, useMemo, useRef, useState} from "react"
import {View} from "react-native"
import {useLocalMiniApps} from "@/stores/applets"
import LocalMiniApp from "@/components/home/LocalMiniApp"
import composer from "@/services/Composer"
import {usePathname} from "expo-router"
import {Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import CoreModule, {MicPcmEvent} from "core"
import {SETTINGS, useSetting} from "@/stores/settings"
// import {useCactusSTT} from "cactus-react-native"

const decodePcm16Base64ToFloat32 = (base64: string): Float32Array => {
  const binaryString = atob(base64)
  const byteLength = binaryString.length
  const sampleCount = Math.floor(byteLength / 2)
  const samples = new Float32Array(sampleCount)

  for (let i = 0; i < sampleCount; i++) {
    const low = binaryString.charCodeAt(i * 2)
    const high = binaryString.charCodeAt(i * 2 + 1)
    let sample = (high << 8) | low
    if (sample >= 0x8000) {
      sample -= 0x10000
    }
    samples[i] = sample / 0x8000
  }

  return samples
}

const decodePcm16ToFloat32 = (input: ArrayBuffer | ArrayBufferLike): Float32Array => {
  const buffer = input instanceof ArrayBuffer ? input : new Uint8Array(input as any).buffer
  const view = new DataView(buffer)
  const sampleCount = Math.floor(buffer.byteLength / 2)
  const samples = new Float32Array(sampleCount)

  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true)
    samples[i] = sample / 0x8000
  }

  return samples
}

const LmaContainer = memo(
  function LmaContainer({
    html,
    packageName,
    isActive,
    enabled,
    index,
  }: {
    html: string
    packageName: string
    isActive: boolean
    enabled: boolean
    index: number
  }) {
    // don't waste rendering a webview if the app is not enabled:
    if (!enabled) {
      return null
    }
    return (
      <View
        className={
          isActive ? "absolute inset-0 z-10" : "absolute left-0 top-0 w-[100px] h-[100px] overflow-hidden z-[1]"
          // isActive ? "absolute inset-0 z-10" : "absolute left-0 w-[100px] h-[100px] overflow-hidden z-[1]"
        }
        style={!isActive ? {bottom: index * 12} : undefined}
        pointerEvents={isActive ? "auto" : "none"}>
        <LocalMiniApp html={html} packageName={packageName} />
      </View>
    )
  },
  (prev, next) => {
    // Only re-render if active state changes or the html/packageName changed
    return (
      prev.isActive === next.isActive &&
      prev.html === next.html &&
      prev.packageName === next.packageName &&
      prev.index === next.index &&
      prev.enabled === next.enabled
    )
  },
)

function Compositor() {
  const lmas = useLocalMiniApps()
  const pathname = usePathname()
  const viewShotRef = useRef<View>(null)
  const [packageName, setPackageName] = useState<string | null>(null)
  const {getCurrentParams} = useNavigationHistory()
  const [offlineCaptionsRunning, setOfflineCaptionsRunning] = useSetting(SETTINGS.offline_captions_running.key)
  const [offlineTranslationRunning, setOfflineTranslationRunning] = useSetting(SETTINGS.offline_translation_running.key)

  useEffect(() => {
    if (pathname.includes("/applet/local")) {
      const params = getCurrentParams()
      if (params && params.packageName) {
        setPackageName(params.packageName as string)
      } else {
        setPackageName(null)
      }
    } else {
      setPackageName(null)
    }
  }, [pathname])

  // console.log("COMPOSITOR: Package Name", packageName)

  const isActive = pathname.includes("/applet/local")
  // const activePackageName = pathname.includes("/applet/local") ? packageName : null

  const resolvedLmas = useMemo(() => {
    return lmas
      .filter((lma) => !!lma.version)
      .map((lma) => {
        if (!lma.version) {
          console.error("COMPOSITOR: Local mini app has no version", lma.packageName)
          return null
        }
        const htmlRes = composer.getLocalMiniAppHtml(lma.packageName, lma.version)
        if (htmlRes.is_ok()) {
          return {packageName: lma.packageName, html: htmlRes.value, running: lma.running}
        }
        console.error("COMPOSITOR: Error getting local mini app html", htmlRes.error)
        return null
      })
      .filter(Boolean) as {packageName: string; html: string; running: boolean}[]
  }, [lmas])

  // return null

  // console.log("COMPOSITOR: Resolved Lmas", resolvedLmas.map((lma) => lma.packageName + " " + lma.running))

  // const model = useSpeechToText({
  //   model: WHISPER_TINY_EN,
  // })

  // const cactusSTT = useCactusSTT({
  //   model: "whisper-medium",
  //   options: {
  //     pro: true,
  //     // quantization: "int8",
  //   },
  // })

  const transcription = useRef<string>("")
  let useExecutorch = false
  let useCactus = false
  let useExpoSpeech = true

  const handlePcm = async (pcm: ArrayBuffer) => {
    // if (useExpoSpeech) {
    //   const audioChunk = decodePcm16ToFloat32(pcm)
    //   SpeechTranscriber.realtimeBufferTranscribe(
    //     audioChunk, // Float32Array or number[]
    //     16000, // sample rate
    //   )
    //   return
    // }
    // if (useExecutorch) {
    //   // const audioChunk = new Float32Array(pcm)
    //   const audioChunk = decodePcm16ToFloat32(pcm)
    //   sttModule.streamInsert(audioChunk)
    //   return
    // }
    // const audioChunk = Array.from(new Int16Array(pcm))
    // // const audioChunk = decodePcm16ToFloat32(pcm)
    // // const audioChunk = Array.from(new Float32Array(pcm))
    // const result = await cactusSTT.streamTranscribeProcess({audio: audioChunk})
    // if (result.confirmed) {
    //   // console.log("COMPOSITOR: c:", result.confirmed)
    //   transcription.current += " " + result.confirmed
    //   // if (result.confirmed.length > 100) {
    //   //   transcription.current = transcription.current.slice(-100)
    //   // }
    // }
    // if (result.pending) {
    //   console.log("COMP: P:", result.pending)
    // }
    // console.log("COMP: F:", transcription.current)
  }

  useEffect(() => {
    const initSTT = async () => {
      // await CoreModule.update("core", {
      //   should_send_pcm: true,
      // })

      // await cactusSTT.download({
      //   onProgress: (progress: number) => {
      //     console.log("COMPOSITOR: Downloading cactus model...", progress)
      //   },
      // })

      // await cactusSTT.streamTranscribeStart({
      //   confirmationThreshold: 0.99,
      //   minChunkSize: 32000,
      // })

      const pcmSub = CoreModule.addListener("mic_pcm", (event: MicPcmEvent) => {
        // console.log("COMPOSITOR: Received mic pcm:", event.base64)
        // const samples = decodePcm16Base64ToFloat32(event.base64)
        // sttModule.streamInsert(samples)
        handlePcm(event.pcm)
      })

      return () => {
        pcmSub?.remove()
      }
    }
    initSTT()
  }, [])

  useEffect(() => {
    // cactusSTT.start()
    return () => {
      // cactusSTT.stop()
    }
  }, [offlineCaptionsRunning, offlineTranslationRunning])

  return (
    <View className={`absolute inset-0 ${isActive ? "z-11" : "z-0"}`} pointerEvents="box-none">
      <View className="z-12">
        <MiniAppCapsuleMenu
          viewShotRef={viewShotRef}
          onEllipsisPress={() => {
            // push("/applet/settings", {
            //   packageName: packageName as string,
            //   fromWebView: "true",
            // })
          }}
          packageName={packageName as string}
        />
      </View>
      <Screen preset="fixed" safeAreaEdges={["top"]} KeyboardAvoidingViewProps={{enabled: true}} ref={viewShotRef}>
        <View className="flex-1 -mx-6">
          {resolvedLmas.map((lma, index) => (
            <LmaContainer
              key={lma.packageName}
              html={lma.html}
              packageName={lma.packageName}
              enabled={lma.running}
              isActive={packageName === lma.packageName}
              index={index}
            />
          ))}
        </View>
      </Screen>
    </View>
  )
}

export default Compositor
