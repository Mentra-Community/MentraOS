import React, {useEffect, useMemo, useRef, useState} from "react"
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"
import Svg, {Circle, Path, Rect} from "react-native-svg"

import {
  useMentraLivePairing,
  type MentraLivePairingController,
  type MentraLivePairingPage,
  type MentraLivePairingState,
  type UseMentraLivePairingOptions,
} from "./useMentraLivePairing"

export type MentraLivePairingFlowTheme = {
  background: string
  /** Cards and secondary buttons. */
  card: string
  foreground: string
  /** Primary buttons. */
  buttonBackground: string
  textDim: string
  mutedForeground: string
  primary: string
  border: string
  error: string
  errorBackground: string
}

export type MentraLivePairingFlowTranslate = (key: string, options?: Record<string, string>) => string

/** Pictures the pages show. A page without one draws a plain glasses outline. */
export type MentraLivePairingFlowImages = {
  /** Open glasses, on the scan and connecting pages. */
  glasses?: ImageSourcePropType
  prep?: ImageSourcePropType
  success?: ImageSourcePropType
  pairAudio?: ImageSourcePropType
  forgetIosPairing?: ImageSourcePropType
}

export type MentraLivePairingAlertButton = {text: string; style?: "cancel" | "destructive"; onPress?: () => void}

export type MentraLivePairingPageProps<P extends MentraLivePairingPage = MentraLivePairingPage> = {
  state: Extract<MentraLivePairingState, {page: P}>
  controller: MentraLivePairingController
}

/** Replace any page with your own component; the others stay stock. */
export type MentraLivePairingPageOverrides = {
  [P in MentraLivePairingPage]?: React.ComponentType<MentraLivePairingPageProps<P>>
}

export type MentraLivePairingPagesProps = {
  controller: MentraLivePairingController
  pages?: MentraLivePairingPageOverrides
  theme?: Partial<MentraLivePairingFlowTheme>
  translate?: MentraLivePairingFlowTranslate
  images?: MentraLivePairingFlowImages
  /** Replaces the prep picture, for example with a video of the power button. */
  prepMedia?: React.ReactNode
  /** Shows "I need more help" on the scan and connecting pages. */
  onOpenHelp?: () => void
  /** Shows "Show device picker" on Pair Audio while another audio device is connected. */
  onShowAudioDevicePicker?: () => void
  /** The host's alert. Defaults to the system alert. */
  showAlert?: (title: string, message: string, buttons: MentraLivePairingAlertButton[]) => void
  /** Success says "Continue setup" instead of "Continue": the host has more setup to show. */
  setupRemaining?: boolean
  /** Adds the Bluetooth name on the connecting page. */
  superMode?: boolean
  style?: StyleProp<ViewStyle>
}

export type MentraLivePairingFlowProps = UseMentraLivePairingOptions & Omit<MentraLivePairingPagesProps, "controller">

const MODEL_NAME = "Mentra Live"

const DEFAULT_THEME: MentraLivePairingFlowTheme = {
  background: "#F2F4F3",
  card: "#FFFFFF",
  foreground: "#0E2C1A",
  buttonBackground: "#0E2C1A",
  textDim: "#66736B",
  mutedForeground: "#66736B",
  primary: "#00B869",
  border: "#D7DFDA",
  error: "#C43131",
  errorBackground: "#FBE9E9",
}

const ENGLISH_COPY: Record<string, string> = {
  "common:cancel": "Cancel",
  "common:continue": "Continue",
  "common:success": "Success",
  "common:tryAgain": "Try again",
  "pairing:powerOn": "Power on",
  "pairing:poweredOn": "Continue",
  "pairing:liveChooseGlassesTitle": "Choose your glasses",
  "pairing:liveScanHelpTitle": "Not showing up?",
  "pairing:livePairingScanTitle": "Put your glasses in pairing mode",
  "pairing:connectedOnPhoneTitle": "Glasses may be in use",
  "pairing:connectedOnPhoneHint":
    "Matching glasses are already connected to this phone. If another app is using them, disconnect them there, then scan again.",
  "pairing:liveScanHelpInfo": "Make sure your glasses are charged and powered on.",
  "pairing:liveUpdatedGlassesHint": "Already updated your glasses?",
  "pairing:livePairingModeInfo":
    "New glasses enter pairing mode on their own once they finish starting up. Otherwise, press the power button 3 times quickly. The LED flashes and the glasses speak a 4-character code (0–9, A–F). Match that code on the scan list if more than one unit appears.",
  "pairing:livePairingScanPowerOn": "Turn your glasses on: hold the power button for 5 seconds.",
  "pairing:livePairingScanBody": "Press the power button 3 times quickly. Your glasses will say a 4-character code.",
  "pairing:livePairingScanSearching": "Looking for your glasses",
  "pairing:noGlassesFoundHint": "Make sure you pressed the power button 3 times quickly, then try again.",
  "pairing:notInPairingModeLabel": "Not in pairing mode",
  "pairing:notInPairingModeAlertTitle": "Enter pairing mode",
  "pairing:notInPairingModeAlertMessage":
    "Press the power button 3 times quickly. The LED flashes and the glasses speak a 4-character code. Then select the glasses again.",
  "pairing:liveChooseGlassesHintTitle": "Not on the list?",
  "pairing:liveChooseGlassesHint":
    "Turn your glasses on, then press the power button 3 times quickly to enter pairing mode.",
  "pairing:scanAgain": "Scan Again",
  "pairing:tryAgain": "Try Again",
  "pairing:needMoreHelp": "I need more help",
  "pairing:pairing": "Pairing",
  "pairing:glassesBooting": "Glasses are booting up…",
  "pairing:pairingFailed": "Pairing Failed",
  "pairing:goHome": "Go Home",
  "pairing:openSettings": "Open Settings",
  "pairing:cancelPairing": "Cancel pairing",
  "pairing:cancelPairingConfirmTitle": "Cancel pairing?",
  "pairing:cancelPairingConfirmMessage": "Your glasses will be unpaired from this phone.",
  "pairing:keepPairing": "Keep pairing",
  "pairing:cancelFailed": "Pairing could not be cancelled. Please try again.",
  "pairing:errorTitle": "Error",
  "onboarding:livePowerOnTutorial": "Press and hold the power button for 5 seconds",
  "onboarding:livePowerOnInfo": 'You will hear "Power on"',
  "onboarding:liveConnected": "Mentra Live connected",
  "onboarding:continueSetup": "Continue setup",
  "onboarding:openSettings": "Open Settings",
  "onboarding:btClassicTitle": "Pair Audio",
  "onboarding:btClassicSubtitle": "Connect {{name}} as a Bluetooth audio device",
  "onboarding:btClassicStep1": "Tap Open Settings",
  "onboarding:btClassicStep2": "Tap Bluetooth",
  "onboarding:btClassicStep3": 'Tap "{{name}}" under My Devices or Other Devices',
  "onboarding:btClassicStep4": 'Return to the app once it says "Connected"',
  "onboarding:showDevicePicker": "Show device picker",
  "onboarding:forgetIosPairingTitle": "Forget the old pairing",
  "onboarding:forgetIosPairingSubtitle": "Remove the saved Bluetooth pairing on your iPhone to continue.",
  "onboarding:forgetIosPairingStep1": "Open Settings, then tap Bluetooth.",
  "onboarding:forgetIosPairingStep2": "Tap ⓘ next to {{name}}, then tap Forget This Device.",
  "onboarding:forgetIosPairingStep3": "Return to the Mentra App to pair again.",
  "errors:pairingCouldNotStart":
    "Couldn't start connecting to your {{glassesModel}}. Please make sure Bluetooth is turned on and try again.",
  "errors:pairingBatteryTooLow":
    "The battery on your {{glassesModel}} is too low to pair. Please charge your {{glassesModel}} to at least 25% and try again.",
}

function defaultTranslate(key: string, options?: Record<string, string>): string {
  let value = Object.prototype.hasOwnProperty.call(ENGLISH_COPY, key) ? ENGLISH_COPY[key] : key
  for (const [name, replacement] of Object.entries(options ?? {})) {
    value = value.replaceAll(`{{${name}}}`, replacement)
  }
  return value
}

const defaultAlert = (title: string, message: string, buttons: MentraLivePairingAlertButton[]) =>
  Alert.alert(title, message, buttons)

type PageContext = Required<
  Pick<MentraLivePairingPagesProps, "translate" | "showAlert" | "setupRemaining" | "superMode">
> &
  Pick<MentraLivePairingPagesProps, "images" | "prepMedia" | "onOpenHelp" | "onShowAudioDevicePicker"> & {
    colors: MentraLivePairingFlowTheme
    controller: MentraLivePairingController
  }

/** The stock Mentra Live pairing flow: the Mentra App's pages over `useMentraLivePairing`. */
export function MentraLivePairingFlow({
  initialPage,
  deviceName,
  initializeRuntime,
  onExit,
  onFinished,
  onRetry,
  prepareScan,
  prepareConnect,
  openBluetoothSettings,
  unpair,
  ...pagesProps
}: MentraLivePairingFlowProps) {
  const controller = useMentraLivePairing({
    initialPage,
    deviceName,
    initializeRuntime,
    onExit,
    onFinished,
    onRetry,
    prepareScan,
    prepareConnect,
    openBluetoothSettings,
    unpair,
  })
  const backRef = useRef(controller.back)
  backRef.current = controller.back
  useEffect(() => {
    // Android Back is the page's own back action; a host with a navigator wires it itself through MentraLivePairingPages.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      backRef.current()
      return true
    })
    return () => subscription.remove()
  }, [])
  return <MentraLivePairingPages controller={controller} {...pagesProps} />
}

/** Renders the pages for a controller the host made with `useMentraLivePairing`. */
export function MentraLivePairingPages({
  controller,
  pages,
  theme,
  translate = defaultTranslate,
  images,
  prepMedia,
  onOpenHelp,
  onShowAudioDevicePicker,
  showAlert = defaultAlert,
  setupRemaining = false,
  superMode = false,
  style,
}: MentraLivePairingPagesProps) {
  const colors = useMemo(() => ({...DEFAULT_THEME, ...theme}), [theme])
  const {state} = controller
  const Override = pages?.[state.page] as React.ComponentType<MentraLivePairingPageProps> | undefined
  const context: PageContext = {
    colors,
    controller,
    translate,
    images,
    prepMedia,
    onOpenHelp,
    onShowAudioDevicePicker,
    showAlert,
    setupRemaining,
    superMode,
  }
  return (
    <SafeAreaView edges={["top", "bottom"]} style={[styles.safeArea, {backgroundColor: colors.background}, style]}>
      {Override ? <Override state={state} controller={controller} /> : <StockPage state={state} context={context} />}
    </SafeAreaView>
  )
}

function StockPage({state, context}: {state: MentraLivePairingState; context: PageContext}) {
  switch (state.page) {
    case "prep":
      return <PrepPage context={context} />
    case "scan":
      return <ScanPage context={context} state={state} />
    case "connecting":
      return <ConnectingPage context={context} state={state} />
    case "pair_audio":
      return <PairAudioPage context={context} state={state} />
    case "forget_ios_pairing":
      return <ForgetIosPairingPage context={context} state={state} />
    case "success":
      return <SuccessPage context={context} />
    case "failure":
      return <FailurePage context={context} state={state} />
  }
}

function PrepPage({context}: {context: PageContext}) {
  const {colors, controller, translate, images, prepMedia} = context
  return (
    <View style={styles.page}>
      <Header colors={colors} onBack={controller.back} title={MODEL_NAME} />
      <GuideStep
        colors={colors}
        info={translate("onboarding:livePowerOnInfo")}
        media={prepMedia ?? <GuideImage colors={colors} source={images?.prep} />}
        subtitle={translate("onboarding:livePowerOnTutorial")}
        title={translate("pairing:powerOn")}
      />
      <FlowButton colors={colors} label={translate("pairing:poweredOn")} onPress={controller.continueToScan} />
    </View>
  )
}

function ScanPage({context, state}: {context: PageContext; state: Extract<MentraLivePairingState, {page: "scan"}>}) {
  const {colors, controller, translate, images, onOpenHelp} = context
  const title =
    state.status === "in_use"
      ? translate("pairing:connectedOnPhoneTitle")
      : state.status === "choosing"
        ? translate("pairing:liveChooseGlassesTitle")
        : state.status === "not_found"
          ? translate("pairing:liveScanHelpTitle")
          : // Before any unit is found the app cannot know its firmware, so the 3-press step shows while searching.
            translate("pairing:livePairingScanTitle")
  const list = (maxHeight: number, marginVertical: number) => (
    <ScrollView style={{maxHeight}} contentContainerStyle={[styles.list, {marginVertical}]}>
      {state.glasses.map((item) => {
        const subtitle = item.inPairingMode
          ? item.label
          : `${item.label} · ${translate("pairing:notInPairingModeLabel")}`
        return (
          <GlassesRow
            colors={colors}
            key={item.id}
            onPress={() => controller.select(item)}
            subtitle={subtitle}
            title={MODEL_NAME}
          />
        )
      })}
    </ScrollView>
  )

  let body: React.ReactNode
  if (state.status === "not_found") {
    body = (
      <View style={styles.helpBlock}>
        <Body colors={colors} medium>
          {translate("pairing:liveScanHelpInfo")}
        </Body>
        <Body colors={colors} semibold>
          {translate("pairing:liveUpdatedGlassesHint")}
        </Body>
        <Body colors={colors} muted small>
          {translate("pairing:livePairingModeInfo")}
        </Body>
        <FlowButton colors={colors} label={translate("pairing:scanAgain")} onPress={controller.scanAgain} />
      </View>
    )
  } else if (!state.scanning) {
    // A scan stopped with glasses listed (a permission was refused), or matching glasses are in use.
    body = (
      <View style={styles.timedOutBlock}>
        <Body colors={colors} muted small>
          {translate(state.status === "in_use" ? "pairing:connectedOnPhoneHint" : "pairing:noGlassesFoundHint")}
        </Body>
        {state.glasses.length > 0 ? list(220, 8) : null}
        <FlowButton colors={colors} label={translate("pairing:tryAgain")} onPress={controller.scanAgain} />
      </View>
    )
  } else if (state.status !== "choosing") {
    body = (
      <View style={styles.searchingBlock}>
        <Body colors={colors} medium>
          {translate("pairing:livePairingScanPowerOn")}
        </Body>
        <Body colors={colors} medium>
          {translate("pairing:livePairingScanBody")}
        </Body>
        <View style={styles.searchingRow}>
          <ActivityIndicator color={colors.foreground} size="small" testID="live-scan-searching-spinner" />
          <Text style={[styles.small, {color: colors.mutedForeground}]}>
            {translate("pairing:livePairingScanSearching")}
          </Text>
        </View>
      </View>
    )
  } else {
    // Other people's glasses can fill the list before yours appear, so the pairing-mode steps stay on screen.
    body = (
      <>
        {list(300, 16)}
        <View style={[styles.hint, {backgroundColor: colors.background}]}>
          <Text style={[styles.hintTitle, {color: colors.foreground}]}>
            {translate(
              state.someNotInPairingMode ? "pairing:notInPairingModeAlertTitle" : "pairing:liveChooseGlassesHintTitle",
            )}
          </Text>
          <Text style={[styles.small, {color: colors.foreground}]}>
            {translate(
              state.someNotInPairingMode ? "pairing:notInPairingModeAlertMessage" : "pairing:liveChooseGlassesHint",
            )}
          </Text>
        </View>
      </>
    )
  }

  return (
    <View style={styles.page}>
      <Header colors={colors} onBack={controller.back} />
      <View style={styles.centered}>
        <View style={[styles.card, styles.scanCard, {backgroundColor: colors.card}]}>
          <GlassesPicture colors={colors} source={images?.glasses} style={styles.scanImage} />
          <Text style={[styles.cardTitle, {color: colors.textDim}]}>{title}</Text>
          {body}
        </View>
      </View>
      <HelpButton context={context} onOpenHelp={onOpenHelp} />
    </View>
  )
}

const LIVE_TIPS = [
  "Make sure your Mentra Live is fully charged.",
  "pairing:livePairingScanBody",
  "Try restarting your glasses.",
  "Check that your phone's Bluetooth is enabled.",
]

function ConnectingPage({
  context,
  state,
}: {
  context: PageContext
  state: Extract<MentraLivePairingState, {page: "connecting"}>
}) {
  const {colors, controller, translate, images, onOpenHelp, superMode} = context
  const progress = useRef(new Animated.Value(0)).current
  const [tipIndex, setTipIndex] = useState(0)

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 85,
      duration: 75_000,
      useNativeDriver: false,
      easing: Easing.out(Easing.exp),
    }).start()
    const timer = setInterval(() => setTipIndex((index) => (index + 1) % LIVE_TIPS.length), 8000)
    return () => clearInterval(timer)
  }, [progress])

  const tip = LIVE_TIPS[tipIndex]
  const name = state.device.name
  return (
    <View style={styles.page}>
      <Header colors={colors} onBack={controller.back} />
      <View style={styles.centered}>
        <View style={[styles.card, styles.loaderCard, {backgroundColor: colors.card}]}>
          <Text style={[styles.cardTitle, {color: colors.foreground}]}>{translate("pairing:pairing")}</Text>
          <Text style={[styles.cardTitleRegular, {color: colors.foreground}]}>
            {MODEL_NAME}
            {superMode && name && name !== "NOTREQUIREDSKIP" ? ` - ${name}` : ""}
          </Text>
          <View style={styles.loaderImage}>
            <GlassesPicture colors={colors} source={images?.glasses} style={styles.loaderPicture} />
          </View>
          <View style={[styles.progressTrack, {backgroundColor: colors.border}]}>
            <Animated.View
              style={[
                styles.progressFill,
                {
                  backgroundColor: colors.primary,
                  width: progress.interpolate({inputRange: [0, 100], outputRange: ["0%", "100%"]}),
                },
              ]}
            />
          </View>
          {state.booting ? (
            <View style={[styles.booting, {backgroundColor: colors.background}]}>
              <Text style={[styles.bootingText, {color: colors.primary}]}>{translate("pairing:glassesBooting")}</Text>
            </View>
          ) : null}
          <Body colors={colors} muted small>
            {tip.includes(":") ? translate(tip) : tip}
          </Body>
          <View style={styles.cancelRow}>
            <FlowButton
              colors={colors}
              compact
              label={translate("common:cancel")}
              onPress={controller.back}
              variant="alternate"
            />
          </View>
        </View>
      </View>
      <HelpButton context={context} onOpenHelp={onOpenHelp} />
    </View>
  )
}

function PairAudioPage({
  context,
  state,
}: {
  context: PageContext
  state: Extract<MentraLivePairingState, {page: "pair_audio"}>
}) {
  const {colors, controller, translate, images, showAlert, onShowAudioDevicePicker} = context
  const cancellingRef = useRef(false)
  const name = state.deviceName

  // Audio setup cannot be skipped: leaving Pair Audio cancels the pairing and unpairs the glasses.
  const askToCancel = () => {
    if (cancellingRef.current) return
    showAlert(translate("pairing:cancelPairingConfirmTitle"), translate("pairing:cancelPairingConfirmMessage"), [
      {text: translate("pairing:keepPairing"), style: "cancel"},
      {
        text: translate("pairing:cancelPairing"),
        style: "destructive",
        onPress: () => {
          if (cancellingRef.current) return
          cancellingRef.current = true
          void controller.cancelPairing().then((cancelled) => {
            cancellingRef.current = false
            if (!cancelled) showAlert(translate("pairing:errorTitle"), translate("pairing:cancelFailed"), [])
          })
        },
      },
    ])
  }

  return (
    <View style={styles.page}>
      <Header
        backLabel={translate("pairing:cancelPairing")}
        colors={colors}
        onBack={state.canCancel ? askToCancel : undefined}
      />
      <GuideStep
        bullets={[
          translate("onboarding:btClassicStep1"),
          translate("onboarding:btClassicStep2"),
          translate("onboarding:btClassicStep3", {name}),
          translate("onboarding:btClassicStep4"),
        ]}
        colors={colors}
        media={<GuideImage colors={colors} source={images?.pairAudio} />}
        subtitle={translate("onboarding:btClassicSubtitle", {name})}
        title={translate("onboarding:btClassicTitle")}
      />
      <FlowButton
        colors={colors}
        label={translate("onboarding:openSettings")}
        onPress={controller.openBluetoothSettings}
      />
      {state.otherAudioConnected && onShowAudioDevicePicker ? (
        <View style={styles.extraButton}>
          <FlowButton
            colors={colors}
            label={translate("onboarding:showDevicePicker")}
            onPress={onShowAudioDevicePicker}
            variant="secondary"
          />
        </View>
      ) : null}
    </View>
  )
}

function ForgetIosPairingPage({
  context,
  state,
}: {
  context: PageContext
  state: Extract<MentraLivePairingState, {page: "forget_ios_pairing"}>
}) {
  const {colors, controller, translate, images} = context
  // Underscores wrap mid-token, so `Mentra_Live_E511` was clipping to `Mentra_Live_` and hiding the code.
  const name = state.deviceName.trim().replace(/_/g, " ") || MODEL_NAME
  return (
    <View style={styles.page}>
      <Header colors={colors} onBack={controller.back} />
      <GuideStep
        bullets={[
          translate("onboarding:forgetIosPairingStep1"),
          translate("onboarding:forgetIosPairingStep2", {name}),
          translate("onboarding:forgetIosPairingStep3"),
        ]}
        colors={colors}
        media={<GuideImage colors={colors} source={images?.forgetIosPairing} />}
        subtitle={translate("onboarding:forgetIosPairingSubtitle")}
        title={translate("onboarding:forgetIosPairingTitle")}
      />
      <FlowButton
        colors={colors}
        label={translate("pairing:openSettings")}
        onPress={controller.openBluetoothSettings}
      />
    </View>
  )
}

function SuccessPage({context}: {context: PageContext}) {
  const {colors, controller, translate, images, setupRemaining} = context
  return (
    <View style={[styles.page, styles.pageNoHeader]}>
      <GuideStep
        centered
        colors={colors}
        media={<GuideImage colors={colors} source={images?.success} />}
        subtitle={translate("onboarding:liveConnected")}
        title={translate("common:success")}
      />
      <FlowButton
        colors={colors}
        label={translate(setupRemaining ? "onboarding:continueSetup" : "common:continue")}
        onPress={controller.finish}
      />
    </View>
  )
}

function FailurePage({
  context,
  state,
}: {
  context: PageContext
  state: Extract<MentraLivePairingState, {page: "failure"}>
}) {
  const {colors, controller, translate} = context
  const appear = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(appear, {toValue: 1, duration: 800, useNativeDriver: true}).start()
  }, [appear])
  return (
    <View style={[styles.page, styles.pageNoHeader]}>
      <Animated.View
        style={[
          styles.failure,
          {opacity: appear, transform: [{translateY: appear.interpolate({inputRange: [0, 1], outputRange: [50, 0]})}]},
        ]}>
        <View style={[styles.failureIcon, {backgroundColor: colors.errorBackground}]}>
          <Svg height={80} viewBox="0 0 24 24" width={80}>
            <Circle cx={12} cy={12} fill={colors.error} r={10} />
            <Path d="M12 7v6" stroke={colors.errorBackground} strokeLinecap="round" strokeWidth={2} />
            <Circle cx={12} cy={16.5} fill={colors.errorBackground} r={1.2} />
          </Svg>
        </View>
        <Text style={[styles.failureTitle, {color: colors.foreground}]}>{translate("pairing:pairingFailed")}</Text>
        <Text style={[styles.failureMessage, {color: colors.textDim}]}>
          {translate(state.error, {glassesModel: MODEL_NAME})}
        </Text>
        <View style={styles.failureActions}>
          <FlowButton colors={colors} label={translate("common:tryAgain")} onPress={controller.retry} />
          <FlowButton
            colors={colors}
            label={translate("pairing:goHome")}
            onPress={controller.exit}
            variant="alternate"
          />
        </View>
      </Animated.View>
    </View>
  )
}

// --- building blocks ---

function Header({
  backLabel,
  colors,
  onBack,
  title,
}: {
  backLabel?: string
  colors: MentraLivePairingFlowTheme
  onBack?: () => void
  title?: string
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        {onBack ? (
          <Pressable
            accessibilityLabel={backLabel ?? "Back"}
            accessibilityRole="button"
            hitSlop={12}
            onPress={onBack}
            testID="pairing-back">
            <Svg fill="none" height={28} stroke={colors.foreground} strokeWidth={2} viewBox="0 0 24 24" width={28}>
              <Path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </Pressable>
        ) : null}
      </View>
      {title ? <Text style={[styles.headerTitle, {color: colors.foreground}]}>{title}</Text> : null}
      <View style={[styles.headerSide, styles.headerRight]}>
        <MentraMark color={colors.primary} />
      </View>
    </View>
  )
}

/** One onboarding-style step: title, subtitle, info, a square picture, numbered steps. */
function GuideStep({
  bullets,
  centered = false,
  colors,
  info,
  media,
  subtitle,
  title,
}: {
  bullets?: string[]
  centered?: boolean
  colors: MentraLivePairingFlowTheme
  info?: string
  media: React.ReactNode
  subtitle: string
  title: string
}) {
  const align = centered ? "center" : "left"
  return (
    <ScrollView contentContainerStyle={styles.guideContent} style={styles.guide}>
      <View style={styles.guideText}>
        <Text style={[styles.guideTitle, {color: colors.foreground, textAlign: align}]}>{title}</Text>
        <Text style={[styles.guideSubtitle, {color: colors.foreground, textAlign: align}]}>{subtitle}</Text>
        {info ? (
          <View style={styles.infoRow}>
            <Svg fill="none" height={20} stroke={colors.mutedForeground} strokeWidth={2} viewBox="0 0 24 24" width={20}>
              <Circle cx={12} cy={12} r={10} />
              <Path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
            </Svg>
            <Text style={[styles.info, {color: colors.mutedForeground}]}>{info}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.guideMedia}>{media}</View>
      <View style={styles.guideSpacer} />
      {bullets ? (
        <View style={styles.bullets}>
          {bullets.map((bullet, index) => (
            <View key={bullet} style={styles.bulletRow}>
              <Text style={[styles.bullet, {color: colors.foreground}]}>{`${index + 1}.`}</Text>
              <Text style={[styles.bullet, styles.bulletText, {color: colors.foreground}]}>{bullet}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  )
}

function GuideImage({colors, source}: {colors: MentraLivePairingFlowTheme; source?: ImageSourcePropType}) {
  return <GlassesPicture colors={colors} source={source} style={styles.fill} />
}

function GlassesPicture({
  colors,
  source,
  style,
}: {
  colors: MentraLivePairingFlowTheme
  source?: ImageSourcePropType
  style: StyleProp<ViewStyle>
}) {
  if (source) return <Image resizeMode="contain" source={source} style={style as never} />
  return (
    <View style={[style, styles.glassesFallback]}>
      <Svg fill="none" height={64} stroke={colors.textDim} strokeWidth={1.5} viewBox="0 0 48 24" width={128}>
        <Rect height={12} rx={5} width={17} x={3} y={6} />
        <Rect height={12} rx={5} width={17} x={28} y={6} />
        <Path d="M20 11c2.5-2 5.5-2 8 0M3 9 1 6M45 9l2-3" strokeLinecap="round" />
      </Svg>
    </View>
  )
}

function GlassesRow({
  colors,
  onPress,
  subtitle,
  title,
}: {
  colors: MentraLivePairingFlowTheme
  onPress: () => void
  subtitle: string
  title: string
}) {
  return (
    <Pressable
      accessibilityLabel={`${title}, ${subtitle}`}
      accessibilityRole="button"
      onAccessibilityTap={onPress}
      onPress={onPress}
      style={({pressed}) => [styles.row, {backgroundColor: colors.card, opacity: pressed ? 0.2 : 1}]}>
      <View style={styles.rowText}>
        <Text numberOfLines={2} style={[styles.rowTitle, {color: colors.foreground}]}>
          {title}
        </Text>
        <Text numberOfLines={2} style={[styles.rowSubtitle, {color: colors.mutedForeground}]}>
          {subtitle}
        </Text>
      </View>
      <View accessible={false} pointerEvents="none" testID="pairing-device-chevron">
        <Svg fill="none" height={24} stroke={colors.foreground} strokeWidth={2} viewBox="0 0 24 24" width={24}>
          <Path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </View>
    </Pressable>
  )
}

function HelpButton({context, onOpenHelp}: {context: PageContext; onOpenHelp?: () => void}) {
  if (!onOpenHelp) return null
  return (
    <FlowButton
      colors={context.colors}
      label={context.translate("pairing:needMoreHelp")}
      onPress={onOpenHelp}
      variant="secondary"
    />
  )
}

function Body({
  children,
  colors,
  medium,
  muted,
  semibold,
  small,
}: {
  children: React.ReactNode
  colors: MentraLivePairingFlowTheme
  medium?: boolean
  muted?: boolean
  semibold?: boolean
  small?: boolean
}) {
  return (
    <Text
      style={[
        small ? styles.small : styles.body,
        {color: muted ? colors.mutedForeground : colors.foreground},
        medium && styles.medium,
        semibold && styles.semibold,
        styles.centerText,
      ]}>
      {children}
    </Text>
  )
}

function FlowButton({
  colors,
  compact = false,
  label,
  onPress,
  variant = "primary",
}: {
  colors: MentraLivePairingFlowTheme
  compact?: boolean
  label: string
  onPress: () => void
  variant?: "primary" | "secondary" | "alternate"
}) {
  const background =
    variant === "primary" ? colors.buttonBackground : variant === "secondary" ? colors.card : colors.background
  const text = variant === "primary" ? colors.card : colors.buttonBackground
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        compact && styles.buttonCompact,
        {backgroundColor: background, borderColor: colors.border, opacity: pressed ? 0.9 : 1},
      ]}
      testID={`button-${label}`}>
      <Text style={[styles.buttonText, {color: text}]}>{label}</Text>
    </Pressable>
  )
}

function MentraMark({color}: {color: string}) {
  return (
    <Svg fill="none" height={18} viewBox="0 0 50 27" width={33}>
      <Rect fill={color} height={11.8457} width={11.8457} y={14.8072} />
      <Path d="M9.36639 0L30.7163 14.8072V26.6529L9.36639 11.8457V0Z" fill={color} />
      <Path d="M28.6501 0L50 14.8072V26.6529L28.6501 11.8457V0Z" fill={color} />
    </Svg>
  )
}

const styles = StyleSheet.create({
  safeArea: {flex: 1},
  page: {flex: 1, paddingBottom: 16, paddingHorizontal: 24},
  pageNoHeader: {paddingTop: 24},
  header: {alignItems: "center", flexDirection: "row", height: 56, justifyContent: "space-between"},
  headerSide: {minWidth: 48},
  headerRight: {alignItems: "flex-end"},
  headerTitle: {flex: 1, fontSize: 18, fontWeight: "600", textAlign: "center"},
  centered: {flex: 1, justifyContent: "center"},
  card: {borderRadius: 24, padding: 24},
  scanCard: {gap: 24},
  loaderCard: {borderRadius: 16, gap: 16},
  scanImage: {alignSelf: "center", height: 90, width: 156},
  cardTitle: {fontSize: 20, fontWeight: "600", textAlign: "center"},
  cardTitleRegular: {fontSize: 20, textAlign: "center"},
  helpBlock: {gap: 12, paddingVertical: 8},
  timedOutBlock: {gap: 16, paddingVertical: 16},
  searchingBlock: {alignItems: "center", gap: 16, justifyContent: "center", paddingVertical: 8},
  searchingRow: {alignItems: "center", flexDirection: "row", gap: 8, justifyContent: "center"},
  list: {gap: 8},
  row: {alignItems: "center", borderRadius: 16, flexDirection: "row", justifyContent: "space-between", padding: 12},
  rowText: {flex: 1, paddingHorizontal: 10},
  rowTitle: {fontSize: 14, fontWeight: "600"},
  rowSubtitle: {fontSize: 12},
  hint: {borderRadius: 16, gap: 4, paddingHorizontal: 16, paddingVertical: 12},
  hintTitle: {fontSize: 14, fontWeight: "600"},
  body: {fontSize: 16, lineHeight: 22},
  small: {fontSize: 14, lineHeight: 20},
  medium: {fontWeight: "500"},
  semibold: {fontWeight: "600"},
  centerText: {textAlign: "center"},
  loaderImage: {alignItems: "center", height: 150, justifyContent: "center", paddingVertical: 16},
  loaderPicture: {height: 150, width: "100%"},
  progressTrack: {borderRadius: 6, height: 12, overflow: "hidden", width: "100%"},
  progressFill: {borderRadius: 6, height: "100%"},
  booting: {borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8},
  bootingText: {fontSize: 14, fontWeight: "500", textAlign: "center"},
  cancelRow: {alignItems: "flex-end"},
  guide: {flex: 1, marginHorizontal: -24},
  guideContent: {paddingHorizontal: 24},
  guideText: {gap: 12, marginBottom: 16, paddingTop: 12},
  guideTitle: {fontSize: 24, fontWeight: "600"},
  guideSubtitle: {fontSize: 18},
  infoRow: {flexDirection: "row", gap: 8},
  info: {flex: 1, fontSize: 14, fontWeight: "500", lineHeight: 16},
  guideMedia: {aspectRatio: 1, marginHorizontal: -24},
  guideSpacer: {height: 48},
  fill: {height: "100%", width: "100%"},
  glassesFallback: {alignItems: "center", justifyContent: "center"},
  bullets: {gap: 8, paddingHorizontal: 8, paddingBottom: 16},
  bulletRow: {flexDirection: "row", gap: 8},
  bullet: {fontSize: 16, fontWeight: "600"},
  bulletText: {flex: 1},
  extraButton: {marginTop: 8},
  failure: {alignItems: "center", flex: 1, justifyContent: "center", paddingHorizontal: 16},
  failureIcon: {
    alignItems: "center",
    borderRadius: 65,
    height: 130,
    justifyContent: "center",
    marginBottom: 32,
    width: 130,
  },
  failureTitle: {fontSize: 28, fontWeight: "700", marginBottom: 16, textAlign: "center"},
  failureMessage: {fontSize: 16, lineHeight: 24, marginBottom: 48, paddingHorizontal: 16, textAlign: "center"},
  failureActions: {gap: 12, width: "100%"},
  button: {
    alignItems: "center",
    borderRadius: 50,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  buttonCompact: {minHeight: 0, minWidth: 96, paddingHorizontal: 16, paddingVertical: 8},
  buttonText: {fontSize: 14, fontWeight: "500", textAlign: "center"},
})
