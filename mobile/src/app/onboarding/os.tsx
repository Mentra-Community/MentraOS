import {SETTINGS, useSetting} from "@mentra/engine"
import {Image, type ImageSource} from "expo-image"
import {useState} from "react"
import {Pressable, View, type ImageStyle, type TextStyle, type ViewStyle} from "react-native"

import {Screen, Text} from "@/components/ignite"
import {focusEffectPreventBack, usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {typography} from "@/theme"

interface OnboardingDetail {
  title: string
  description: string
}

interface OnboardingPage {
  title: string
  hero: ImageSource
  details: OnboardingDetail[]
}

const HERO_SHADOW_INSET = -6

export default function MentraOSOnboarding() {
  const pushPrevious = usePushPrevious()
  const [, setOnboardingOsCompleted] = useSetting<boolean>(SETTINGS.onboarding_os_completed.key)
  const [currentIndex, setCurrentIndex] = useState(0)

  focusEffectPreventBack()

  const pages: OnboardingPage[] = [
    {
      title: translate("onboarding:osStartMiniappTitle"),
      hero: require("@assets/onboarding/os/figma/start-miniapp.png"),
      details: [
        {
          title: translate("onboarding:osTapToLaunchTitle"),
          description: translate("onboarding:osTapToLaunchDescription"),
        },
      ],
    },
    {
      title: translate("onboarding:osMinimizeCloseTitle"),
      hero: require("@assets/onboarding/os/figma/minimize-close.png"),
      details: [
        {
          title: translate("onboarding:osMinimizeTitle"),
          description: translate("onboarding:osMinimizeDescription"),
        },
        {
          title: translate("onboarding:osExitTitle"),
          description: translate("onboarding:osExitDescription"),
        },
      ],
    },
    {
      title: translate("onboarding:osSwitchMiniappsTitle"),
      hero: require("@assets/onboarding/os/figma/running-miniapps.png"),
      details: [
        {
          title: translate("onboarding:osRunningMiniappsTitle"),
          description: translate("onboarding:osRunningMiniappsDescription"),
        },
        {
          title: translate("onboarding:osExpandTrayTitle"),
          description: translate("onboarding:osExpandTrayDescription"),
        },
      ],
    },
    {
      title: translate("onboarding:osMiniappDrawerTitle"),
      hero: require("@assets/onboarding/os/figma/miniapp-drawer.png"),
      details: [
        {
          title: translate("onboarding:osTapGridTitle"),
          description: translate("onboarding:osTapGridDescription"),
        },
        {
          title: translate("onboarding:osSearchTitle"),
          description: translate("onboarding:osSearchDescription"),
        },
      ],
    },
  ]

  const page = pages[currentIndex]
  const isFirstPage = currentIndex === 0
  const isLastPage = currentIndex === pages.length - 1

  const finishOnboarding = () => {
    setOnboardingOsCompleted(true)
    pushPrevious()
  }

  return (
    <Screen
      preset="fixed"
      className="px-0"
      backgroundColor="#ffffff"
      extraAndroidInsets
      safeAreaEdges={["top", "bottom"]}
      StatusBarProps={{hidden: true}}
      statusBarStyle="dark">
      <View style={styles.screen}>
        <View style={styles.page}>
          <Pressable
            accessibilityRole="button"
            onPress={finishOnboarding}
            style={({pressed}) => [styles.skipButton, pressed && styles.pressed]}
            testID="mentraos-onboarding-skip">
            <Text text={translate("common:skip")} style={styles.skipText} />
          </Pressable>

          <View style={styles.titleContainer}>
            <View style={styles.titleSpacer} />
            <Text text={page.title} style={styles.title} />
          </View>

          <View style={styles.heroSpacer} />
          <View style={styles.heroColumn}>
            <View style={styles.hero}>
              <Image
                accessibilityLabel={page.title}
                contentFit="fill"
                source={page.hero}
                style={styles.heroImage}
                testID={`mentraos-onboarding-hero-${currentIndex + 1}`}
              />
            </View>
          </View>

          <View style={styles.detailsSpacer} />
          <View style={styles.details}>
            {page.details.map((detail, index) => (
              <View key={detail.title} style={[styles.detail, index > 0 && styles.additionalDetail]}>
                <Text text={detail.title} style={styles.detailTitle} />
                <View style={styles.detailTextSpacer} />
                <Text text={detail.description} style={styles.detailDescription} />
              </View>
            ))}
          </View>

          <View style={styles.flexSpacer} />
          <View style={[styles.controls, isFirstPage && styles.firstPageControls]}>
            {!isFirstPage && (
              <Pressable
                accessibilityRole="button"
                onPress={() => setCurrentIndex((index) => index - 1)}
                style={({pressed}) => [styles.backButton, pressed && styles.pressed]}
                testID="mentraos-onboarding-back">
                <Text text={translate("common:back")} style={styles.backButtonText} />
              </Pressable>
            )}

            <Pressable
              accessibilityRole="button"
              onPress={isLastPage ? finishOnboarding : () => setCurrentIndex((index) => index + 1)}
              style={({pressed}) => [styles.nextButton, pressed && styles.pressed]}
              testID={isLastPage ? "mentraos-onboarding-done" : "mentraos-onboarding-next"}>
              <Text text={translate(isLastPage ? "common:done" : "common:next")} style={styles.nextButtonText} />
            </Pressable>
          </View>
        </View>
      </View>
    </Screen>
  )
}

const styles = {
  screen: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    flex: 1,
  },
  page: {
    flex: 1,
    maxWidth: 390,
    paddingBottom: 28,
    paddingHorizontal: 14,
    paddingTop: 32,
    position: "relative",
    width: "100%",
  },
  skipButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 6,
    position: "absolute",
    right: 22,
    top: 18,
    zIndex: 1,
  },
  skipText: {
    color: "rgba(0, 0, 0, 0.55)",
    fontFamily: typography.fonts.redHatDisplay.medium,
    fontSize: 15,
    letterSpacing: -0.075,
    lineHeight: 20,
  },
  titleContainer: {
    paddingHorizontal: 10,
    paddingTop: 20,
  },
  titleSpacer: {
    height: 10,
  },
  title: {
    color: "#0e0e0e",
    fontFamily: typography.fonts.redHatDisplay.bold,
    fontSize: 26,
    letterSpacing: -0.572,
    lineHeight: 30,
  },
  heroSpacer: {
    height: 24,
  },
  heroColumn: {
    marginRight: 8,
  },
  hero: {
    aspectRatio: 354 / 330,
    position: "relative",
  },
  heroImage: {
    bottom: HERO_SHADOW_INSET,
    left: HERO_SHADOW_INSET,
    position: "absolute",
    right: HERO_SHADOW_INSET,
    top: HERO_SHADOW_INSET,
  },
  detailsSpacer: {
    height: 16,
  },
  details: {
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  detail: {
    width: "100%",
  },
  additionalDetail: {
    marginTop: 18,
    paddingTop: 4,
  },
  detailTitle: {
    color: "#0e0e0e",
    fontFamily: typography.fonts.redHatDisplay.semibold,
    fontSize: 15,
    letterSpacing: -0.12,
    lineHeight: 20,
  },
  detailTextSpacer: {
    height: 2,
  },
  detailDescription: {
    color: "rgba(0, 0, 0, 0.55)",
    fontFamily: typography.fonts.redHatDisplay.normal,
    fontSize: 14,
    lineHeight: 19,
  },
  flexSpacer: {
    flex: 1,
    minHeight: 8,
  },
  controls: {
    flexDirection: "row",
    gap: 10,
    minHeight: 54,
    width: "100%",
  },
  firstPageControls: {
    paddingLeft: 10,
  },
  backButton: {
    alignItems: "center",
    borderColor: "rgba(0, 0, 0, 0.08)",
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  backButtonText: {
    color: "rgba(0, 0, 0, 0.35)",
    fontFamily: typography.fonts.redHatDisplay.semibold,
    fontSize: 17,
    letterSpacing: -0.204,
    lineHeight: 22,
  },
  nextButton: {
    alignItems: "center",
    backgroundColor: "#1a1a1a",
    borderRadius: 999,
    elevation: 3,
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    shadowColor: "#000000",
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.22,
    shadowRadius: 3,
  },
  nextButtonText: {
    color: "#ffffff",
    fontFamily: typography.fonts.redHatDisplay.semibold,
    fontSize: 17,
    letterSpacing: -0.204,
    lineHeight: 22,
  },
  pressed: {
    opacity: 0.72,
  },
} satisfies Record<string, ImageStyle | TextStyle | ViewStyle>
