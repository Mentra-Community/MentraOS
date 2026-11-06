import {useCallback, useEffect, useRef, useState} from "react"
import {findNodeHandle, Platform, View} from "react-native"
import type {WebView} from "react-native-webview"

import {Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useStressTestStore} from "@/stores/stressTest"
import {useMiniappPresentationStore} from "@/stores/miniappLaunch"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {BgTimer, engine, SETTINGS, useSetting} from "@mentra/engine"
import {
  MiniappView,
  type MiniappScreen,
  type MiniappViewHandle,
  type MiniappViewStatus,
} from "@mentra/engine/miniapp-view"
import {localMiniappRuntime, useAppStatusStore} from "@mentra/engine-host-internal"
import {useNavigationStore, type NavInterceptor} from "@/stores/navigation"
import CapsuleMenu from "@/effects/CapsuleMenu"
import {useRegisterCapsule} from "@/stores/capsule"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {getStreamPreviewCoordinator, STREAM_PREVIEW_BIND_TIMEOUT_MS} from "@/services/streamPreview"
import {
  applyWebStorageReport,
  openWebStorageKeeper,
  parseWebStorageReport,
  webStorageKeeperAfterLoad,
  type WebStorageKeeper,
} from "@/services/miniapps/webStorageMigration"
import {useOldWebStorageReader} from "./OldWebStorageReader"

/**
 * LocalMiniappView — the Mentra App's presentation of a local (or dev)
 * miniapp around the engine's MiniappView: the splash, the capsule, back
 * handling, dev-offline recovery, the stream preview binding and the kept
 * localStorage. The engine's view owns the WebView, the background launch and
 * the ready handshake; the always-on JSContext survives this component
 * unmounting.
 *
 * The <Compositor /> overlay mounts/unmounts it as a miniapp is
 * foregrounded/backgrounded, and owns the opening animation, back-swipe
 * gesture, and capsule button. This component drives the navigation store's
 * `forceGestureEnabled` flag from the WebView's history state so the
 * Compositor only arms its edge-swipe once the WebView is at page 0.
 */

const MAX_LOAD_ATTEMPTS = 10

interface LocalMiniappViewProps {
  packageName: string
  appName?: string
  version?: string
  devUrl?: string
  iconUrl?: string
  devPort?: string
  /** Called when the WebView's content process terminates / errors fatally. */
  onExit: () => void
  onClose: () => void
  onMinimize: () => void
  onShouldCapture?: () => void
  showCapsule?: boolean
  openingComplete?: boolean
}

function LocalMiniappView({
  packageName,
  appName,
  version,
  devUrl,
  iconUrl,
  devPort,
  onExit,
  onClose,
  onMinimize,
  onShouldCapture = () => undefined,
  showCapsule = false,
  openingComplete = false,
}: LocalMiniappViewProps) {
  const {theme} = useAppTheme()
  const insets = useSaferAreaInsets()

  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  // Read inside status handling without re-rendering the view on their own —
  // they're display-only (e.g. a store refresh resolving a lazy icon).
  const appNameRef = useRef(appName)
  appNameRef.current = appName
  const iconUrlRef = useRef(iconUrl)
  iconUrlRef.current = iconUrl

  const viewShotRef = useRef<View | null>(null)
  const miniappViewRef = useRef<MiniappViewHandle | null>(null)
  const webViewRef = useRef<WebView | null>(null)
  const [webViewCanGoBack, setWebViewCanGoBack] = useState(false)
  // Moving a first-party miniapp's web storage to its own origin.
  const {
    reader: oldWebStorageReader,
    read: readOldWebStorage,
    cancel: cancelOldWebStorageRead,
  } = useOldWebStorageReader()
  // The host's copy of the screen's localStorage, and the keeper script this launch's WebView gets.
  const [storageKeeperScript, setStorageKeeperScript] = useState("")
  const storageKeeperRef = useRef<WebStorageKeeper | null>(null)
  const setStorageKeeper = useCallback((next: {keeper: WebStorageKeeper | null; script: string} | null) => {
    storageKeeperRef.current = next?.keeper ?? null
    setStorageKeeperScript(next?.script ?? "")
  }, [])
  const [devMode] = useSetting(SETTINGS.dev_mode.key)
  // Stream preview. For a CAMERA miniapp on Android the WebView is first rendered without its real
  // source: the preview's WebMessageListener only appears in documents that start loading after
  // it is installed, so the source is set once the binding resolves (or its timeout passes).
  const previewEligibleRef = useRef(false)
  const previewBoundInstanceRef = useRef<WebView | null>(null)
  const [holdSource, setHoldSource] = useState(false)
  const holdSourceRef = useRef(holdSource)
  holdSourceRef.current = holdSource

  // Splash state, from the view's status: `ready` lifts it, a failure replaces
  // it with an error line, reload attempts label it in developer mode.
  const [ready, setReady] = useState(false)
  const [loadAttempts, setLoadAttempts] = useState(0)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const [contentRevealed, setContentRevealed] = useState(false)
  const handleSplashHidden = useCallback(() => {
    setContentRevealed(true)
    useMiniappPresentationStore.getState().setRevealedPackageName(packageName)
  }, [packageName])

  const openDevOffline = useCallback(() => {
    engine.miniapps.clearForeground()
    useNavigationStore.getState().push("/applet/dev-offline", {
      packageName,
      name: appNameRef.current,
      iconUrl: iconUrlRef.current,
    })
  }, [packageName])

  const handleStatus = useCallback(
    (status: MiniappViewStatus) => {
      if (status.state === "loading") {
        setReady(false)
        setErrorMessage(undefined)
        setLoadAttempts(status.attempt)
        return
      }
      if (status.state === "ready") {
        setReady(true)
        return
      }
      if (status.reason === "never_ready") {
        setErrorMessage(translate(devMode || devUrl ? "common:miniappNeverReady" : "common:miniappFailedToLoad"))
        return
      }
      if (status.reason === "load_timeout") {
        setErrorMessage(translate("common:miniappFailedToLoad"))
        return
      }
      // Already-registered packages never throw from ensureRunning — a dropped
      // dev server with no on-disk snapshot resolves no screen. Route those
      // reopens to the offline recovery screen.
      if (status.reason !== "launch") {
        if (devUrl) {
          console.warn(`LocalMiniappView: ${packageName} already running but UI unresolved, routing to dev-offline`)
          openDevOffline()
          return
        }
        setErrorMessage(translate("common:miniappUiUnavailable"))
        return
      }
      const {error} = status
      // The age gate kept it from opening (MiniappAgeRestrictedError): the person answered the age question, or was
      // told why on the alert sheet. Close the screen instead of showing an error on it, while this miniapp is still
      // the one in front: a refusal that arrives after the person moved on leaves the screen they're on alone.
      if (error.name === "MiniappAgeRestrictedError") {
        if (useAppStatusStore.getState().foregroundedPackage === packageName) engine.miniapps.clearForeground()
        return
      }
      // A build this Mentra App can't run says why on its screen, as its install would have; a development build too,
      // which is not offline.
      if (error.name === "MiniappIncompatibleHostError") {
        console.warn(`LocalMiniappView: ${error.message}`)
        const {miniappName} = error as Error & {miniappName?: string}
        setErrorMessage(
          translate("miniappInstall:needsNewerApp", {name: miniappName || appNameRef.current || packageName}),
        )
        return
      }
      if (devUrl) {
        // Dev bundle couldn't be resolved (dev server unreachable, or the
        // manifest/background bundle fetch failed) — route to the offline
        // screen with "Try again" / "Re-scan QR" instead of a bare error.
        console.warn(
          `LocalMiniappView: ${packageName} dev bundle unresolvable, routing to dev-offline: ${error.message}`,
        )
        openDevOffline()
        return
      }
      setErrorMessage(error.message)
    },
    [packageName, devUrl, devMode, openDevOffline],
  )

  // Every screen's localStorage: the host keeps a copy in the miniapp's data
  // partition, restores it before the page's own scripts and takes the page's
  // changes. A first-party miniapp's first open on its own origin also moves
  // its keys from the old shared file:// store (the hidden reader runs before
  // the miniapp's page loads).
  const prepareScreen = useCallback(
    async (screen: MiniappScreen, checkpoint: () => void) => {
      const keeper = await openWebStorageKeeper({
        packageName,
        origin: screen.uiOrigin,
        devBuild: screen.devBuild,
        previous: storageKeeperRef.current,
        readOldStore: readOldWebStorage,
        checkpoint,
      })
      checkpoint()
      setStorageKeeper(keeper)
      const previewEligible = localMiniappRuntime.hasManifestPermission(packageName, "CAMERA")
      previewEligibleRef.current = previewEligible
      // Set before the view takes the screen, so the WebView's first render already has no source.
      setHoldSource(previewEligible && Platform.OS === "android")
    },
    [packageName, readOldWebStorage, setStorageKeeper],
  )

  // Each (re)launch gets a fresh preview binding; the keeper stays with the
  // WebView that is still showing until the next launch replaces it.
  useEffect(() => {
    previewBoundInstanceRef.current = null
    return () => {
      cancelOldWebStorageRead()
      getStreamPreviewCoordinator().viewDestroyed(packageName, "miniapp-unmounted")
    }
  }, [packageName, version, devUrl, devPort, cancelOldWebStorageRead])

  // The page changing its localStorage, which the host keeps a copy of.
  const handleMessage = useCallback(
    (data: string) => {
      const keeper = storageKeeperRef.current
      const report = keeper ? parseWebStorageReport(data, keeper) : null
      if (!keeper || !report) return false
      applyWebStorageReport(keeper, report)
      if (report.loaded && keeper.session.mode === "replace") setStorageKeeper(webStorageKeeperAfterLoad(keeper))
      return true
    },
    [setStorageKeeper],
  )

  const {setForceGestureEnabled} = useNavigationStore.getState()

  // Use the same priority interceptor as OfflineAppHost (PR #3266).
  // The home screen remains mounted and can overwrite androidBackFn.
  const navigationActive = useRef(true)
  const beginExit = useCallback(() => {
    navigationActive.current = false
    onExitRef.current()
  }, [])
  const handleWebViewBack = useCallback(() => {
    if (miniappViewRef.current?.goBack()) return
    if (Platform.OS === "ios") onShouldCapture()
    else beginExit()
  }, [beginExit, onShouldCapture])
  const handleWebViewBackRef = useRef(handleWebViewBack)
  handleWebViewBackRef.current = handleWebViewBack
  useEffect(() => {
    if (Platform.OS !== "android") return
    // Register once per mount. Changing presentation callbacks during dismissal
    // must not reactivate the departing miniapp on the next screen.
    navigationActive.current = true
    const interceptor: NavInterceptor = {
      goBack: () => {
        if (!navigationActive.current) return false
        handleWebViewBackRef.current()
        return true
      },
      push: () => {
        if (navigationActive.current) beginExit()
        return false
      },
      replace: () => {
        if (navigationActive.current) beginExit()
        return false
      },
    }
    useNavigationStore.getState().setInterceptor(interceptor)
    return () => {
      navigationActive.current = false
      if (useNavigationStore.getState().interceptor === interceptor) {
        useNavigationStore.getState().setInterceptor(null)
      }
    }
  }, [beginExit])

  // Dynamically toggle the Compositor's left-edge swipe-to-back gesture based on
  // the WebView's navigation state (via the shared `forceGestureEnabled` flag):
  // - Page 0 (no history): enable the Compositor swipe so a back-swipe
  //   backgrounds the miniapp with the real iOS animation.
  // - Has history: disable the Compositor swipe so the WebView's own
  //   allowsBackForwardNavigationGestures handles in-webview back navigation.
  useEffect(() => {
    setForceGestureEnabled(!webViewCanGoBack)
    return () => setForceGestureEnabled(false)
  }, [webViewCanGoBack, setForceGestureEnabled])

  useRegisterCapsule({
    packageName: packageName as string,
    viewShotRef,
    visibleOnRoutes: ["/intentionally-not-a-real-route"],
    onBackPress: handleWebViewBack,
    onClosePress: () => {
      navigationActive.current = false
      onClose()
    },
    onMinimizePress: () => {
      navigationActive.current = false
      onMinimize()
    },
  })

  const bindStreamPreview = useCallback(
    (instance: WebView) => {
      if (webViewRef.current !== instance) return
      // The WebView's own ref is an imperative handle, not a host component, so native is given
      // this wrapper's tag and walks down to the real WebView.
      const hostViewTag = viewShotRef.current ? findNodeHandle(viewShotRef.current) : null
      if (hostViewTag == null) {
        console.warn(`LocalMiniappView: no native tag for the stream-preview binding of ${packageName}`)
        setHoldSource(false)
        return
      }
      let released = false
      const release = () => {
        if (released) return
        released = true
        setHoldSource(false)
      }
      const timer = BgTimer.setTimeout(() => {
        console.warn(`LocalMiniappView: stream-preview bind for ${packageName} is slow; loading without it`)
        release()
      }, STREAM_PREVIEW_BIND_TIMEOUT_MS)
      // The native WebView is often not a child of this wrapper on the first tick, and a miss is
      // permanent: the coordinator keeps that failed binding and every later handshake is refused
      // as unsupported. Retry while this instance is still the mounted one.
      const retryDelaysMs = [0, 50, 150, 400, 800]
      const attempt = (index: number) => {
        if (released || webViewRef.current !== instance) return
        const tag = viewShotRef.current ? findNodeHandle(viewShotRef.current) : hostViewTag
        if (tag == null) {
          if (index + 1 < retryDelaysMs.length) BgTimer.setTimeout(() => attempt(index + 1), retryDelaysMs[index + 1])
          return
        }
        void getStreamPreviewCoordinator()
          .bindView({packageName, hostViewTag: tag})
          .then((result) => {
            if (webViewRef.current !== instance) return
            if (!result.available && index + 1 < retryDelaysMs.length) {
              BgTimer.setTimeout(() => attempt(index + 1), retryDelaysMs[index + 1])
              return
            }
            BgTimer.clearTimeout(timer)
            release()
            // Native answers from the WebView itself: a real document that loaded before the
            // listener existed has no port and needs this, while a held source never loaded one.
            if (result.installReloadRequired && webViewRef.current === instance) {
              getStreamPreviewCoordinator().noteInstallReload(packageName)
              instance.reload()
            }
          })
      }
      attempt(0)
    },
    [packageName],
  )

  const handleWebView = useCallback(
    (instance: WebView | null) => {
      webViewRef.current = instance
      if (!instance || !previewEligibleRef.current || previewBoundInstanceRef.current === instance) return
      previewBoundInstanceRef.current = instance
      // Next tick: React attaches refs child-first, so viewShotRef is still null right now.
      BgTimer.setTimeout(() => bindStreamPreview(instance), 0)
    },
    [bindStreamPreview],
  )

  const handleTerminate = useCallback(() => {
    getStreamPreviewCoordinator().documentEnded(packageName, "content_process_terminated")
    useStressTestStore.getState().recordEvent({packageName, at: Date.now(), kind: "terminate"})
    onExitRef.current()
  }, [packageName])

  const handleLoadError = useCallback(() => {
    useStressTestStore.getState().recordEvent({packageName, at: Date.now(), kind: "error"})
  }, [packageName])

  if (!packageName) {
    return <Text text="Missing required parameters" />
  }

  // While the WebView is mounted but the miniapp hasn't sent `ready` yet,
  // show retry progress on the splash. Once ready, the splash hides; once
  // the retry budget is spent, errorMessage replaces the label.
  let connectingLabel = undefined
  if (loadAttempts > 0 && devMode && !errorMessage) {
    connectingLabel = `Loading… (attempt ${loadAttempts + 1} of ${MAX_LOAD_ATTEMPTS})`
  }
  const showErrorCapsule = !!errorMessage && !contentRevealed

  return (
    <View ref={viewShotRef} collapsable={false} className="flex-1" style={{backgroundColor: theme.colors.background}}>
      {/* The splash uncovers the page and capsule together in the same fade. */}
      <View className="flex-1" style={{zIndex: 0}} pointerEvents={contentRevealed ? "auto" : "none"}>
        {oldWebStorageReader}
        <MiniappView
          ref={miniappViewRef}
          packageName={packageName}
          version={version}
          devUrl={devUrl}
          devPort={devPort}
          colorScheme={theme.isDark ? "dark" : "light"}
          safeAreaInsets={{
            top: insets.top,
            bottom: Platform.OS === "android" ? insets.bottom : 0,
            left: insets.left,
            right: insets.right,
          }}
          onStatus={handleStatus}
          onExit={handleTerminate}
          onCanGoBackChange={setWebViewCanGoBack}
          prepareScreen={prepareScreen}
          beforeContentScript={storageKeeperScript}
          holdSource={holdSource}
          onMessage={handleMessage}
          onWebView={handleWebView}
          onLoadError={handleLoadError}
        />
        {showCapsule && !showErrorCapsule && <CapsuleMenu forceShow={true} />}
      </View>
      {/* Keep one splash mounted as the WebView arrives so its icon and timer do not restart. */}
      <MiniappSplash
        name={appName}
        iconUrl={iconUrl}
        bgColor={theme.colors.background}
        isLoaded={ready && openingComplete}
        error={errorMessage}
        label={connectingLabel}
        devApp={!!devUrl}
        disableFadeIn={true}
        onHidden={handleSplashHidden}
      />
      {/* Loading errors need an escape route above the splash, while the WebView stays untouchable. */}
      {showCapsule && showErrorCapsule && <CapsuleMenu forceShow={true} />}
    </View>
  )
}

export default LocalMiniappView
