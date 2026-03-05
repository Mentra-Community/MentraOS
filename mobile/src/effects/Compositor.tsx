import {memo, useEffect, useMemo, useRef, useState} from "react"
import {View} from "react-native"
import {useLocalMiniApps} from "@/stores/applets"
import LocalMiniApp from "@/components/home/LocalMiniApp"
import composer from "@/services/Composer"
import {usePathname} from "expo-router"
import {Screen} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"

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

  return (
    <View className={`absolute inset-0 ${isActive ? "z-11" : "z-0"}`} pointerEvents="box-none">
      <Screen preset="fixed" safeAreaEdges={["top"]} KeyboardAvoidingViewProps={{enabled: true}} ref={viewShotRef}>
        <View className="z-12">
          <MiniAppDualButtonHeader
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
