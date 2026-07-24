import {SETTINGS, useSetting} from "@mentra/engine"
import {Image} from "expo-image"
import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {PanResponder, ScrollView, View} from "react-native"
import Svg, {Circle, Line, Path, Text as SvgText} from "react-native-svg"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {waitForHeadUp} from "@/components/onboarding/waitForGlassesEvent"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {focusEffectPreventBack, usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"

const MAX_HEAD_UP_ANGLE = 60
const HEAD_UP_FALLBACK_MS = 10_000
const DETECTED_STATE_MS = 1_500

type Stage = "intro" | "head-up" | "head-up-detected" | "angle" | "apps"

interface AnglePoint {
  x: number
  y: number
}

const clampAngle = (angle: number) => Math.max(0, Math.min(MAX_HEAD_UP_ANGLE, angle))

const pointOnArc = (angle: number, radius: number): AnglePoint => {
  const radians = (angle * Math.PI) / 180
  return {
    x: 42 + radius * Math.cos(radians),
    y: 216 - radius * Math.sin(radians),
  }
}

const describeArc = (angle: number, radius: number) => {
  const start = pointOnArc(0, radius)
  const end = pointOnArc(angle, radius)
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 0 ${end.x} ${end.y}`
}

function HeadUpAngleControl({
  angle,
  onAngleChange,
  onAngleCommit,
}: {
  angle: number
  onAngleChange: (angle: number) => void
  onAngleCommit: (angle: number) => void
}) {
  const {theme} = useAppTheme()
  const angleRef = useRef(angle)
  angleRef.current = angle

  const updateFromTouch = useCallback(
    (x: number, y: number) => {
      const degrees = (Math.atan2(216 - y, x - 42) * 180) / Math.PI
      const nextAngle = clampAngle(Math.round(degrees))
      angleRef.current = nextAngle
      onAngleChange(nextAngle)
    },
    [onAngleChange],
  )

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          updateFromTouch(event.nativeEvent.locationX, event.nativeEvent.locationY)
        },
        onPanResponderMove: (event) => {
          updateFromTouch(event.nativeEvent.locationX, event.nativeEvent.locationY)
        },
        onPanResponderRelease: () => {
          onAngleCommit(angleRef.current)
        },
      }),
    [onAngleCommit, updateFromTouch],
  )

  const start = pointOnArc(0, 164)
  const end = pointOnArc(MAX_HEAD_UP_ANGLE, 164)
  const knob = pointOnArc(angle, 164)
  const ticks = Array.from({length: 31}, (_, index) => index * 2)

  return (
    <View
      className="h-[426px] w-full items-center justify-between rounded-2xl bg-primary-foreground px-4 py-4"
      testID="even-realities-angle-control">
      <Text
        className="text-center text-xs text-secondary-foreground"
        text={translate("onboarding:evenAdjustInstruction")}
      />
      <View className="h-[240px] w-[294px]" {...panResponder.panHandlers}>
        <Svg width="100%" height="100%" viewBox="0 0 294 240">
          <Path
            d={`M 42 216 L ${start.x} ${start.y} A 164 164 0 0 0 ${end.x} ${end.y} Z`}
            fill={theme.colors.border}
            opacity={0.45}
          />
          <Path d={describeArc(MAX_HEAD_UP_ANGLE, 164)} fill="none" stroke={theme.colors.border} strokeWidth={5} />
          {ticks.map((tick) => {
            const outer = pointOnArc(tick, 164)
            const inner = pointOnArc(tick, tick % 10 === 0 ? 146 : 156)
            return (
              <Line
                key={tick}
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke={theme.colors.secondary_foreground}
                strokeWidth={tick % 10 === 0 ? 1.5 : 0.75}
              />
            )
          })}
          {[0, 10, 20, 30, 40, 50, 60].map((tick) => {
            const label = pointOnArc(tick, 133)
            return (
              <SvgText
                key={tick}
                x={label.x}
                y={label.y + 4}
                fill={theme.colors.secondary_foreground}
                fontSize={11}
                textAnchor="middle">
                {tick}
              </SvgText>
            )
          })}
          <Line x1={42} y1={216} x2={start.x} y2={start.y} stroke={theme.colors.secondary_foreground} strokeWidth={1} />
          <Circle cx={42} cy={216} r={9} fill={theme.colors.background} stroke={theme.colors.secondary_foreground} />
          <Path
            d={describeArc(angle, 164)}
            fill="none"
            stroke={theme.colors.primary}
            strokeLinecap="round"
            strokeWidth={9}
          />
          <Circle cx={knob.x} cy={knob.y} r={12} fill={theme.colors.primary} />
        </Svg>
      </View>
      <Text className="text-center text-xl font-semibold text-secondary-foreground" text={`${angle}°`} />
      <Text className="text-center text-xs text-secondary-foreground" text={translate("onboarding:evenAdjustNote")} />
    </View>
  )
}

export default function EvenRealitiesOnboarding() {
  const pushPrevious = usePushPrevious()
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [, setOnboardingEvenRealitiesCompleted] = useSetting<boolean>(SETTINGS.onboarding_even_realities_completed.key)
  const [onboardingOsCompleted] = useSetting<boolean>(SETTINGS.onboarding_os_completed.key)
  const [headUpAngle, setHeadUpAngle] = useSetting<number>(SETTINGS.head_up_angle.key)
  const [stage, setStage] = useState<Stage>("intro")
  const [showHeadUpFallback, setShowHeadUpFallback] = useState(false)
  const [previewAngle, setPreviewAngle] = useState(() => clampAngle(Number(headUpAngle ?? 34)))

  const model = defaultWearable === "Even Realities G2" ? "G2" : "G1"
  const page = stage === "angle" ? 2 : stage === "apps" ? 3 : 1

  const finishOnboarding = useCallback(() => {
    setOnboardingEvenRealitiesCompleted(true)
    pushPrevious()
  }, [pushPrevious, setOnboardingEvenRealitiesCompleted])

  const handleClose = useCallback(() => {
    const messageKey = onboardingOsCompleted
      ? "onboarding:evenEndOnboardingHomeMessage"
      : "onboarding:evenEndOnboardingMessage"

    showAlert(translate("onboarding:evenEndOnboardingTitle"), translate(messageKey), [
      {text: translate("common:no"), onPress: () => {}},
      {text: translate("onboarding:confirmSkip"), onPress: finishOnboarding},
    ])
  }, [finishOnboarding, onboardingOsCompleted])

  focusEffectPreventBack(handleClose)

  useEffect(() => {
    if (stage !== "head-up") return

    const controller = new AbortController()
    const fallbackTimer = setTimeout(() => setShowHeadUpFallback(true), HEAD_UP_FALLBACK_MS)
    void waitForHeadUp(controller.signal).then(() => {
      if (!controller.signal.aborted) {
        setStage("head-up-detected")
      }
    })

    return () => {
      controller.abort()
      clearTimeout(fallbackTimer)
    }
  }, [stage])

  useEffect(() => {
    if (stage !== "head-up-detected") return
    const timer = setTimeout(() => setStage("angle"), DETECTED_STATE_MS)
    return () => clearTimeout(timer)
  }, [stage])

  const continueOnboarding = () => {
    if (stage === "intro") {
      setShowHeadUpFallback(false)
      setStage("head-up")
      return
    }
    if (stage === "head-up") {
      setStage("angle")
      return
    }
    if (stage === "angle") {
      setStage("apps")
      return
    }
    if (stage === "apps") {
      finishOnboarding()
    }
  }

  const commitAngle = useCallback(
    (angle: number) => {
      void setHeadUpAngle(angle)
    },
    [setHeadUpAngle],
  )

  const isHeadUpStage = stage === "head-up" || stage === "head-up-detected"
  const pageContent =
    stage === "intro"
      ? {
          image: require("@assets/onboarding/even-realities/explore-headup.png"),
          title: translate("onboarding:evenExploreTitle"),
          description: translate("onboarding:evenExploreDescription", {model}),
        }
      : {
          image: require("@assets/onboarding/even-realities/connect-apps.png"),
          title: translate("onboarding:evenConnectAppsTitle"),
          description: translate("onboarding:evenConnectAppsDescription"),
        }

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <View className="flex-1">
        <Header
          leftIcon="x"
          onLeftPress={handleClose}
          RightActionComponent={
            <View className="flex-row items-center gap-4">
              <Text className="text-sm font-medium text-muted-foreground" text={`${page}/3`} />
              <MentraLogoStandalone />
            </View>
          }
        />

        {isHeadUpStage ? (
          <View className="flex-1 items-center justify-around pb-12">
            <Image
              source={require("@assets/glasses/even_realities/logo_black.png")}
              style={{width: 123, height: 23, tintColor: theme.colors.secondary_foreground}}
              contentFit="contain"
            />
            <Image
              source={
                stage === "head-up-detected"
                  ? require("@assets/onboarding/even-realities/head-up-detected.png")
                  : require("@assets/onboarding/even-realities/head-up-waiting.png")
              }
              style={{width: "115%", aspectRatio: 390 / 241}}
              contentFit="contain"
              testID="even-realities-head-up-image"
            />
            {stage === "head-up-detected" ? (
              <View className="h-8 w-8 items-center justify-center rounded-full bg-primary">
                <Text className="text-xl text-background" text="✓" />
              </View>
            ) : (
              <View className="h-8" />
            )}
            <View className="items-center gap-2 px-4">
              <Text
                className="text-center text-sm font-medium text-foreground"
                text={translate("onboarding:evenLookUpDescription")}
              />
              <Text
                className="max-w-[266px] text-center text-xl font-semibold leading-[22px] text-secondary-foreground"
                text={translate("onboarding:evenLookUpTitle")}
              />
            </View>
            {showHeadUpFallback && stage === "head-up" ? (
              <Button flexContainer tx="common:continue" onPress={continueOnboarding} />
            ) : (
              <View className="h-11" />
            )}
          </View>
        ) : (
          <>
            <ScrollView
              className="flex-1 -mx-6 px-6"
              contentContainerClassName="items-center pb-6"
              showsVerticalScrollIndicator={false}>
              <Image
                source={require("@assets/glasses/even_realities/logo_black.png")}
                style={{width: 123, height: 23, marginBottom: 16}}
                contentFit="contain"
              />
              <View className="w-full px-2">
                {stage === "angle" ? (
                  <HeadUpAngleControl
                    angle={previewAngle}
                    onAngleChange={setPreviewAngle}
                    onAngleCommit={commitAngle}
                  />
                ) : (
                  <Image
                    source={pageContent.image}
                    style={{width: "100%", aspectRatio: 330 / 430}}
                    contentFit="contain"
                    testID={`even-realities-${stage}-image`}
                  />
                )}
                <View className="gap-4 pt-6">
                  <Text
                    className="text-xl font-semibold leading-[23px] text-secondary-foreground"
                    text={stage === "angle" ? translate("onboarding:evenAdjustTitle") : pageContent.title}
                  />
                  <Text
                    className="text-[15px] leading-[22px] text-secondary-foreground"
                    text={stage === "angle" ? translate("onboarding:evenAdjustDescription") : pageContent.description}
                  />
                </View>
              </View>
            </ScrollView>
            <View className="px-2 pt-4">
              <Button flexContainer tx="common:continue" onPress={continueOnboarding} />
            </View>
          </>
        )}
      </View>
    </Screen>
  )
}
