import {Image, ImageSource} from "expo-image"
import {useVideoPlayer, VideoView, VideoSource, VideoPlayer} from "expo-video"
import {useState, useCallback, useEffect, useMemo, useRef} from "react"
import {View, ViewStyle, ActivityIndicator, Platform, Animated} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Text, Button, Header, Icon} from "@/components/ignite"
import {focusEffectPreventBack, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {translate} from "@/i18n/translate"
import {BackgroundTimer} from "@/utils/timers"

interface BaseStep {
  name: string
  transition: boolean
  title?: string
  titleCentered?: boolean
  subtitle?: string
  subtitleCentered?: boolean
  subtitle2?: string
  subtitleSmall?: string
  info?: string
  bullets?: string[]
  numberedBullets?: string[]
  fadeOut?: boolean // if true, the step will fade out after the duration
  waitFn?: () => Promise<void>
}

interface VideoStep extends BaseStep {
  type: "video"
  source: VideoSource
  poster?: ImageSource
  playCount: number
  containerStyle?: ViewStyle
  containerClassName?: string
  replayable?: boolean
  showButtonImmediately?: boolean // Show the continue/end button immediately without waiting for video to finish
  buttonTimeoutMs?: number // Fallback timeout to show button if video doesn't finish (ms)
}

interface ImageStep extends BaseStep {
  type: "image"
  source: ImageSource
  containerStyle?: ViewStyle
  containerClassName?: string
  duration?: number // ms before showing next button, undefined = immediate
}

export type OnboardingStep = VideoStep | ImageStep

interface OnboardingGuideProps {
  steps: OnboardingStep[]
  showSkipButton?: boolean
  autoStart?: boolean
  startButtonText?: string
  endButtonText?: string
  endButtonFn?: () => void
  skipFn?: () => void
  showCloseButton?: boolean
  showHeader?: boolean
  preventBack?: boolean
  androidBackFn?: () => void
  requiresGlassesConnection?: boolean
}

// Find next video step's source for preloading
const findNextVideoSource = (steps: OnboardingStep[], fromIndex: number): VideoSource | null => {
  for (let i = fromIndex; i < steps.length; i++) {
    if (steps[i].type === "video") {
      return steps[i].source
    }
  }
  return null
}

export function OnboardingGuide({
  steps,
  showSkipButton = true,
  showCloseButton = true,
  autoStart = false,
  showHeader = true,
  startButtonText = "Start",
  endButtonText = "Done",
  endButtonFn,
  skipFn,
  preventBack = false,
  requiresGlassesConnection: _requiresGlassesConnection = false,
}: OnboardingGuideProps) {
  const {clearHistoryAndGoHome} = useNavigationHistory()
  const {theme} = useAppTheme()
  const [superMode] = useSetting(SETTINGS.super_mode.key)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [showNextButton, setShowNextButton] = useState(false)
  const [showReplayButton, setShowReplayButton] = useState(false)
  const [hasStarted, setHasStarted] = useState(autoStart)
  const [playCount, setPlayCount] = useState(0)
  const [transitionCount, setTransitionCount] = useState(0)
  const [uiIndex, setUiIndex] = useState(1)
  const [activePlayer, setActivePlayer] = useState<1 | 2>(1)
  // const [isVideoLoading, setIsVideoLoading] = useState(true)
  // const [showPoster, setShowPoster] = useState(true)
  const [player1Loading, setPlayer1Loading] = useState(true)
  const [player2Loading, setPlayer2Loading] = useState(true)
  const [showPoster, setShowPoster] = useState(false)
  const [waitState, setWaitState] = useState(true)
  const resettingRef = useRef(false)
  const navigatingRef = useRef(false)
  const [exitRequested, setExitRequested] = useState(false)
  const [showStepSkipButton, setShowStepSkipButton] = useState(false)
  const stepSkipTimeoutRef = useRef<number | null>(null)
  const buttonFallbackTimeoutRef = useRef<number | null>(null)

  // Fade animation state
  const fadeOpacity = useRef(new Animated.Value(1)).current

  // Initialize players with first video sources found
  const initialSource1 = useMemo(() => findNextVideoSource(steps, 0), [steps])
  const initialSource2 = useMemo(() => findNextVideoSource(steps, 1), [steps])

  const player1: VideoPlayer = useVideoPlayer(initialSource1, (player: any) => {
    player.loop = false
    player.audioMixingMode = "mixWithOthers"
  })
  const player2: VideoPlayer = useVideoPlayer(initialSource2, (player: any) => {
    player.loop = false
    player.audioMixingMode = "mixWithOthers"
  })

  const currentPlayer = activePlayer === 1 ? player1 : player2

  const nonTransitionVideoFiles = steps.filter((step) => !step.transition)
  const counter = translate("onboarding:stepCounter", {index: uiIndex, total: nonTransitionVideoFiles.length})
  const step = steps[currentIndex]
  const isCurrentStepImage = step.type === "image"
  const isCurrentStepVideo = step.type === "video"

  // Handle image step timing
  useEffect(() => {
    if (!hasStarted || !isCurrentStepImage) return

    if (step.transition) {
      // Auto-advance transition images
      const timer = BackgroundTimer.setTimeout(() => {
        handleNext(false)
      }, step.duration ?? 500)
      return () => clearTimeout(timer)
    }

    if (step.duration) {
      const timer = BackgroundTimer.setTimeout(() => {
        setShowNextButton(true)
      }, step.duration)
      return () => BackgroundTimer.clearTimeout(timer)
    } else {
      setShowNextButton(true)
    }
    return () => {}
  }, [currentIndex, hasStarted, isCurrentStepImage])

  const handleClose = useCallback(() => {
    // setExitRequested(true)
    if (skipFn) {
      skipFn()
    } else {
      clearHistoryAndGoHome()
    }
  }, [skipFn, clearHistoryAndGoHome])

  // Only show poster if video takes longer than 2 seconds to load (fallback for slow connections)
  useEffect(() => {
    const isLoading = (player1Loading && activePlayer === 1) || (player2Loading && activePlayer === 2)

    if (!isLoading) {
      setShowPoster(false)
      return
    }

    const timer = BackgroundTimer.setTimeout(() => {
      setShowPoster(true)
    }, 2000)
    return () => BackgroundTimer.clearTimeout(timer)
  }, [player1Loading, player2Loading, activePlayer])

  // Function to perform the actual navigation
  const performNavigation = useCallback(
    (manual: boolean = false) => {
      console.log(`ONBOARD: performNavigation(${manual})`)

      if (currentIndex === steps.length - 1) {
        navigatingRef.current = false
        // handleExit()
        return
      }

      console.log("ONBOARD: step", step)
      console.log("ONBOARD: manual", manual)

      if (manual && !step.transition) {
        setUiIndex(uiIndex + 1)
      }

      const nextIndex = currentIndex < steps.length - 1 ? currentIndex + 1 : 0
      const nextStep = steps[nextIndex]

      console.log(`ONBOARD: current: ${currentIndex} next: ${nextIndex}`)

      resettingRef.current = true
      BackgroundTimer.setTimeout(() => {
        resettingRef.current = false
      }, 100)

      setShowNextButton(false)
      setShowReplayButton(false)
      setCurrentIndex(nextIndex)
      setPlayCount(0)
      setShowStepSkipButton(false)
      if (stepSkipTimeoutRef.current) {
        BackgroundTimer.clearTimeout(stepSkipTimeoutRef.current)
        stepSkipTimeoutRef.current = null
      }

      if (nextStep.transition) {
        setTransitionCount(transitionCount + 1)
      }

      // If next step is an image, just pause current player and preload next video
      if (nextStep.type === "image") {
        player1.pause()
        player2.pause()

        // Preload next video source into inactive player
        const nextVideoSource = findNextVideoSource(steps, nextIndex + 1)
        if (nextVideoSource) {
          if (activePlayer === 1) {
            player2.replaceAsync(nextVideoSource)
            setPlayer2Loading(true)
          } else {
            player1.replaceAsync(nextVideoSource)
            setPlayer1Loading(true)
          }
        }
        // Allow next navigation after a short delay
        setTimeout(() => {
          navigatingRef.current = false
        }, 100)
        return
      }

      // Next step is a video - handle player swapping
      const nextNextVideoSource = findNextVideoSource(steps, nextIndex + 1)

      try {
        if (activePlayer === 1) {
          setActivePlayer(2)
          player2.replaceAsync(nextStep.source)
          player2.play()
          if (nextNextVideoSource) {
            player1.replaceAsync(nextNextVideoSource)
            setPlayer1Loading(true)
          }
          setTimeout(() => {
            player1.pause()
          }, 100)
        } else {
          setActivePlayer(1)
          player1.replaceAsync(nextStep.source)
          player1.play()
          if (nextNextVideoSource) {
            player2.replaceAsync(nextNextVideoSource)
            setPlayer2Loading(true)
          }
          setTimeout(() => {
            player2.pause()
          }, 100)
        }
      } catch (error) {
        console.log("ONBOARD: error swapping players", error)
      }

      // Allow next navigation after a short delay
      setTimeout(() => {
        navigatingRef.current = false
      }, 100)
      console.log(`ONBOARD: current is now ${nextIndex}`)
    },
    [
      currentIndex,
      activePlayer,
      uiIndex,
      steps,
      transitionCount,
      clearHistoryAndGoHome,
      fadeOpacity,
      handleClose,
      player1,
      player2,
      step.transition,
    ],
  )

  const handleNext = useCallback(
    async (manual: boolean = false) => {
      console.log(`ONBOARD: handleNext(${manual})`)

      // Prevent multiple rapid calls from corrupting player state
      if (navigatingRef.current) {
        console.log("ONBOARD: handleNext blocked - navigation in progress or fading")
        return
      }
      navigatingRef.current = true

      setShowNextButton(false)

      // Check if current step should fade out
      if (step.fadeOut) {
        console.log("ONBOARD: Starting fade out transition")

        // Fade out, swap, fade in
        Animated.timing(fadeOpacity, {
          toValue: 0,
          duration: 450,
          useNativeDriver: true,
        }).start(async () => {
          await performNavigation(manual)
          Animated.timing(fadeOpacity, {
            toValue: 1,
            duration: 450,
            useNativeDriver: true,
          }).start(() => {
            navigatingRef.current = false
          })
        })
        return
      }

      performNavigation(manual)
    },
    [step, fadeOpacity, performNavigation],
  )

  const handleEndButton = useCallback(() => {
    if (endButtonFn) {
      // Don't set exitRequested when using custom endButtonFn - let the function handle navigation
      // Setting exitRequested causes the component to render null immediately, causing a blank screen
      endButtonFn()
    } else {
      setExitRequested(true)
      clearHistoryAndGoHome()
    }
  }, [endButtonFn, clearHistoryAndGoHome])

  const handleBack = useCallback(() => {
    setUiIndex(uiIndex - 1)
    setPlayCount(0)

    fadeOpacity.setValue(1)

    // The start is a special case
    if (currentIndex === 0 || currentIndex === 1) {
      resettingRef.current = true
      setHasStarted(autoStart) // if autoStart is true, we don't want to reset the hasStarted state (because it's already started)
      setCurrentIndex(0)
      setActivePlayer(1)
      setShowReplayButton(false)
      setShowNextButton(false)
      setUiIndex(1)

      const firstVideoSource = findNextVideoSource(steps, 0)
      const secondVideoSource = findNextVideoSource(steps, 1)

      if (firstVideoSource) {
        player1.replaceAsync(firstVideoSource)
        player1.currentTime = 0
        player1.pause()
      }
      if (secondVideoSource) {
        player2.replaceAsync(secondVideoSource)
        player2.currentTime = 0
        player2.pause()
      }
      BackgroundTimer.setTimeout(() => {
        resettingRef.current = false
      }, 0)
      return
    }

    // If the previous index is a transition, go back two indices
    let prevIndex = currentIndex - 1
    let doubleBack = false
    if (steps[prevIndex].transition) {
      prevIndex = currentIndex - 2
      doubleBack = true
    }

    if (prevIndex < 0) {
      prevIndex = 0
    }

    const prevStep = steps[prevIndex]
    setCurrentIndex(prevIndex)
    setShowReplayButton(prevStep.type === "video" && (prevStep.replayable ?? true))
    setShowNextButton(false)

    // If going back to an image, just pause players
    if (prevStep.type === "image") {
      player1.pause()
      player2.pause()
      return
    }

    // Going back to a video
    const nextVideoSource = findNextVideoSource(steps, prevIndex + 1)

    if (doubleBack) {
      if (activePlayer === 1) {
        player1.replaceAsync(prevStep.source)
        if (nextVideoSource) player2.replaceAsync(nextVideoSource)
        player1.pause()
      } else {
        player2.replaceAsync(prevStep.source)
        if (nextVideoSource) player1.replaceAsync(nextVideoSource)
        player2.pause()
      }
      return
    }

    if (activePlayer === 1) {
      setActivePlayer(2)
      player2.replaceAsync(prevStep.source)
      if (nextVideoSource) player1.replaceAsync(nextVideoSource)
      player2.pause()
    } else {
      setActivePlayer(1)
      player1.replaceAsync(prevStep.source)
      if (nextVideoSource) player2.replaceAsync(nextVideoSource)
      player1.pause()
    }
  }, [currentIndex, uiIndex, activePlayer, steps, autoStart, fadeOpacity, player1, player2])

  if (preventBack) {
    focusEffectPreventBack(() => {
      console.log("ONBOARD: preventBack back handler called")
      if (hasStarted && !isFirstStep) {
        handleBack()
      }
    })
  }

  // Video status change listener
  useEffect(() => {
    if (isCurrentStepImage) return

    const subscription = currentPlayer.addListener("statusChange", (status: any) => {
      // console.log("ONBOARD: statusChange", status)

      if (currentIndex === 0 && !autoStart) {
        return
      }

      if (status.status === "readyToPlay") {
        currentPlayer.play()
        // Show button immediately if the step has showButtonImmediately flag
        if (step.type === "video" && step.showButtonImmediately) {
          setShowNextButton(true)
        }
      }
      if (status.error) {
        setShowNextButton(true)
      }
    })

    return () => subscription.remove()
  }, [currentPlayer, currentIndex, autoStart, isCurrentStepImage, step])

  useEffect(() => {
    const sub1 = player1.addListener("sourceLoad", (_status: any) => {
      // console.log("ONBOARD: player1 sourceLoad", status)
      setPlayer1Loading(false)
    })

    const sub2 = player2.addListener("sourceLoad", (_status: any) => {
      // console.log("ONBOARD: player2 sourceLoad", status)
      setPlayer2Loading(false)
    })

    return () => {
      sub1.remove()
      sub2.remove()
    }
  }, [player1])

  // Video playing change listener
  useEffect(() => {
    if (isCurrentStepImage) return

    const subscription = currentPlayer.addListener("playingChange", (status: any) => {
      // console.log("ONBOARD: playingChange", status.isPlaying, resettingRef.current, playCount)
      if (resettingRef.current) return // ignore playingChange listener while resetting
      if (!status.isPlaying && currentPlayer.currentTime >= currentPlayer.duration - 0.1) {
        if (step.transition) {
          handleNext(false)
          return
        }
        setShowNextButton(true)
        // -1 means play forever
        if (step.playCount === -1) {
          setPlayCount((prev) => prev + 1)
          currentPlayer.currentTime = 0
          currentPlayer.play()
          return
        }
        if (step.type === "video" && playCount < step.playCount - 1) {
          setPlayCount((prev) => prev + 1)
          currentPlayer.currentTime = 0
          currentPlayer.play()
          return
        }
        if (step.replayable) {
          setShowReplayButton(true)
        }
      }
    })

    return () => subscription.remove()
  }, [currentPlayer, step, handleNext, playCount, isCurrentStepImage])

  const handleReplay = useCallback(() => {
    if (isCurrentStepVideo) {
      setShowReplayButton(false)
      setPlayCount(0)
      currentPlayer.currentTime = 0
      currentPlayer.play()
    }
  }, [currentPlayer, isCurrentStepVideo])

  const handleStart = useCallback(() => {
    setHasStarted(true)
    if (isCurrentStepVideo) {
      currentPlayer.play()
    }
  }, [currentPlayer, isCurrentStepVideo])

  const handleSkip = useCallback(() => {
    if (skipFn) {
      skipFn()
    } else {
      clearHistoryAndGoHome()
    }
  }, [skipFn, clearHistoryAndGoHome])

  const renderNumberedBullets = useCallback(() => {
    if (!step.numberedBullets) {
      return null
    }
    return (
      <View className={`flex flex-col flex-grow justify-center gap-2 flex-1 px-2`}>
        {step.numberedBullets.map((bullet, index) => (
          <View key={index} className="flex-row items-start gap-2">
            <Text className="text-md font-semibold" text={`${index + 1}.`} />
            <Text className="text-md font-semibold" text={bullet} />
          </View>
        ))}
      </View>
    )
  }, [step])

  const renderBullets = useCallback(() => {
    // console.log("ONBOARD: renderBullets", step.bullets)
    // console.log("ONBOARD: currentIndex", currentIndex)
    // console.log("ONBOARD: steps.bullets2", steps[currentIndex].bullets)
    // console.log("ONBOARD: bullets", bullets)
    if (!step.bullets) {
      return null
    }

    return (
      <View className={`flex gap-4 flex-grow`}>
        <Text className="text-xl font-semibold" text={step.bullets[0]} />
        {step.bullets.slice(1).map((bullet, index) => (
          <View key={index} className="flex-row items-start gap-2 pl-4">
            <Text className="text-[15px] font-medium">•</Text>
            <Text className="flex-1 text-[15px] font-medium" text={bullet} />
          </View>
        ))}
      </View>
    )
  }, [step])

  const isLastStep = currentIndex === steps.length - 1
  const isFirstStep = currentIndex === 0

  const renderComposedVideo = () => {
    let s = step as VideoStep
    let showPlayer1 = activePlayer === 1 && !showPoster && !exitRequested
    let showPlayer2 = activePlayer === 2 && !showPoster && !exitRequested
    return (
      <>
        <View className={`absolute top-0 left-0 right-0 bottom-0 ${s.containerClassName}`}>
          <VideoView
            player={player1}
            style={{
              width: "100%",
              height: "100%",
              marginLeft: showPlayer1 ? 0 : "100%",
            }}
            nativeControls={false}
            allowsVideoFrameAnalysis={false}
            onFirstFrameRender={() => {}}
          />
        </View>
        <View className={`absolute top-0 left-0 right-0 bottom-0 ${s.containerClassName}`}>
          <VideoView
            player={player2}
            style={{
              width: "100%",
              height: "100%",
              marginLeft: showPlayer2 ? 0 : "100%",
            }}
            nativeControls={false}
            allowsVideoFrameAnalysis={false}
            onFirstFrameRender={() => {}}
          />
        </View>
        {/* Poster image overlay - shown until a video is loaded on a slow connection: */}
        {showPoster && s.poster && (
          <View className="absolute top-0 left-0 right-0 bottom-0 z-10">
            <Image source={s.poster} style={{width: "100%", height: "100%"}} contentFit="contain" />
          </View>
        )}
        {showPoster && !s.poster && (
          <View className="absolute top-0 left-0 right-0 bottom-0 z-10 items-center justify-center bg-background">
            <ActivityIndicator size="large" color={theme.colors.foreground} />
          </View>
        )}
        {/* {showPoster && (
          <View className="absolute top-0 left-0 right-0 bottom-0 z-10 items-center justify-center bg-background">
            <ActivityIndicator size="large" color={theme.colors.foreground} />
          </View>
        )} */}
      </>
    )
  }

  const renderDebugVideos = () => {
    let s = step as VideoStep
    let showPoster = false

    // console.log("ONBOARD: player1Loading", player1Loading)
    // console.log("ONBOARD: player2Loading", player2Loading)
    // console.log("ONBOARD: activePlayer", activePlayer)
    // console.log("ONBOARD: showPoster", showPoster)
    return (
      <>
        <View className="relative flex-col w-full">
          <View
            className={`flex flex-row w-full z-100 px-20 bg-chart-4/20 rounded-lg ${
              Platform.OS === "ios" ? "absolute" : ""
            }`}>
            <View style={{width: s.poster ? "33%" : "50%"}}>
              {!player1Loading && (
                <VideoView
                  player={player1}
                  style={{
                    width: "100%",
                    aspectRatio: 1,
                    borderWidth: activePlayer === 1 && !showPoster ? 2 : 0,
                    borderColor: theme.colors.primary,
                  }}
                  nativeControls={false}
                  allowsVideoFrameAnalysis={false}
                  onFirstFrameRender={() => {
                    console.log("ONBOARD: player1 first frame render")
                  }}
                />
              )}
              {player1Loading && (
                <View className="absolute top-0 left-0 right-0 bottom-0 z-10 items-center justify-center">
                  <ActivityIndicator size="large" color={theme.colors.foreground} />
                </View>
              )}
            </View>
            <View style={{width: s.poster ? "33%" : "50%"}}>
              {!player2Loading && (
                <VideoView
                  player={player2}
                  style={{
                    width: "100%",
                    aspectRatio: 1,
                    borderWidth: activePlayer === 2 && !showPoster ? 2 : 0,
                    borderColor: theme.colors.primary,
                  }}
                  nativeControls={false}
                  allowsVideoFrameAnalysis={false}
                  onFirstFrameRender={() => {
                    console.log("ONBOARD: player2 first frame render")
                  }}
                />
              )}
              {player2Loading && (
                <View className="absolute top-0 left-0 right-0 bottom-0 z-10 items-center justify-center">
                  <ActivityIndicator size="large" color={theme.colors.foreground} />
                </View>
              )}
            </View>
            {s.poster && (
              <Image
                source={s.poster}
                style={{
                  width: "33%",
                  height: "100%",
                  borderWidth: showPoster ? 2 : 0,
                  borderColor: theme.colors.primary,
                }}
                contentFit="contain"
              />
            )}
            {!s.poster && (
              <View className="w-1/3 items-center justify-center bg-background">
                <ActivityIndicator size="large" color={theme.colors.foreground} />
              </View>
            )}
          </View>
          <View className="relative w-full h-full">{renderComposedVideo()}</View>
        </View>
      </>
    )
  }

  const renderContent = () => {
    if (isCurrentStepImage) {
      return (
        <View style={step.containerStyle} className={step.containerClassName}>
          <Image
            source={step.source}
            style={{
              width: "100%",
              height: "100%",
            }}
            contentFit="contain"
          />
        </View>
      )
    }

    if (superMode) {
      return renderDebugVideos()
    }

    return renderComposedVideo()
  }

  // when a step has a waitFn, set the wait state to true, and when it resolves, set it to false
  useEffect(() => {
    if (!step.waitFn) return

    let cancelled = false
    setWaitState(true)

    step.waitFn().then(() => {
      if (cancelled) return
      setWaitState(false)
      BackgroundTimer.setTimeout(() => {
        if (cancelled) return
        handleNext(true)
      }, 1500)
    })

    return () => {
      cancelled = true
    }
  }, [step.waitFn])

  // const wouldShowContinue = hasStarted && (showNextButton || showPoster) && !waitState
  // const actuallyShowContinue = hasStarted && (showNextButton || showPoster)
  // let showContinue = hasStarted && (showNextButton || showPoster)
  // if (waitState) {
  //   showContinue = false
  // }
  // if (devMode) {
  //   showContinue = true
  // }

  useEffect(() => {
    if (step.waitFn) {
      stepSkipTimeoutRef.current = BackgroundTimer.setTimeout(() => {
        setShowStepSkipButton(true)
      }, 10000)
    } else {
      setShowStepSkipButton(false)
      if (stepSkipTimeoutRef.current) {
        BackgroundTimer.clearTimeout(stepSkipTimeoutRef.current)
      }
    }
  }, [step.waitFn])

  // Fallback timeout to show button if video doesn't finish
  useEffect(() => {
    if (buttonFallbackTimeoutRef.current) {
      BackgroundTimer.clearTimeout(buttonFallbackTimeoutRef.current)
      buttonFallbackTimeoutRef.current = null
    }

    if (!hasStarted || step.transition || step.waitFn || showNextButton) {
      return
    }

    const timeoutMs = step.type === "video" ? step.buttonTimeoutMs : undefined
    if (timeoutMs) {
      buttonFallbackTimeoutRef.current = BackgroundTimer.setTimeout(() => {
        console.log("ONBOARD: button fallback timeout triggered")
        setShowNextButton(true)
      }, timeoutMs)
    }

    return () => {
      if (buttonFallbackTimeoutRef.current) {
        BackgroundTimer.clearTimeout(buttonFallbackTimeoutRef.current)
        buttonFallbackTimeoutRef.current = null
      }
    }
  }, [currentIndex, hasStarted, step, showNextButton])

  const renderContinueButton = () => {
    // let showLoader = (waitState && step.waitFn) || !showNextButton
    // the wait state should take precedence over the show next flag:
    // if (showLoader && step.waitFn && !waitState) {
    //   showLoader = false
    // }

    // if (showLoader && !step.waitFn) {
    //   showLoader = false
    // }

    if (showStepSkipButton) {
      return (
        <Button
          flex
          tx="common:skip"
          preset="secondary"
          onPress={() => {
            handleNext(true)
          }}
        />
      )
    }

    if (step.waitFn) {
      return null
    }

    if (!showNextButton) {
      return null
    }

    if (isLastStep) {
      return <Button flex text={endButtonText} onPress={handleEndButton} />
    }

    return (
      <Button
        flex
        // highlight when the button would actually show:
        // style={!wouldShowContinue && {backgroundColor: theme.colors.warning}}
        tx="common:continue"
        preset="primary"
        onPress={() => {
          handleNext(true)
        }}
      />
    )
  }

  const renderStepContent = () => {
    // if (!step.subtitle && !step.subtitle2 && !step.subtitleSmall && !step.info) {
    //   return null
    // }

    // if (!step.info) {
    //   return (
    //     <View id="step-content" className="flex mb-4 h-26 gap-3 bg-blue-500 w-full justify-center">
    //       {step.title && <Text className="text-center text-2xl font-semibold" text={step.title} />}
    //       {step.subtitle && <Text className="text-center text-[18px]" text={step.subtitle} />}
    //     </View>
    //   )
    // }

    return (
      <View id="step-content" className="flex mb-4 h-34 gap-3 w-full justify-start">
        {step.title && (
          <Text
            className={`${
              (step.titleCentered ?? false) ? "text-center" : "text-start"
            } text-2xl font-semibold text-foreground`}
            text={step.title}
          />
        )}
        {step.subtitle && (
          <Text
            className={`${(step.subtitleCentered ?? false) ? "text-center" : "text-start"} text-[18px] text-foreground`}
            text={step.subtitle}
          />
        )}
        {step.info && (
          <View className="flex flex-row gap-2 justify-start">
            <Icon name="info" size={20} color={theme.colors.muted_foreground} />
            {/* TODO: why is this text escaping it's container?? */}
            <Text
              className="text-start text-sm font-medium text-muted-foreground mr-5"
              text={step.info}
              numberOfLines={2}
              style={{lineHeight: 16}}
            />
          </View>
        )}
      </View>
    )
  }

  const renderStepCheck = () => {
    const showCheck = step.waitFn && !waitState

    const showDebug = superMode && waitState && step.waitFn
    if (!showCheck && !showDebug) {
      // still show a small height if there is a waitFn so the text doesn't move around:
      // if (step.waitFn) {
      return <View className="h-12" />
      // }
    }
    return (
      <View id="bottom" className={`flex justify-end h-12 ${superMode ? "bg-chart-4" : ""}`}>
        {showCheck && (
          <View className="flex-1 justify-center">
            <View className="flex flex-row justify-center items-center">
              <View className="bg-primary rounded-full p-1.5">
                <Icon name="check" size={24} color={theme.colors.background} />
              </View>
            </View>
          </View>
        )}
        {/* if waitState is true, show a primary indicator with a height of 12px that overlays the content */}
        {showDebug && (
          <View className="flex-1 justify-center">
            <View className="flex flex-row justify-center items-center gap-2">
              <Text className="text-center text-sm font-bold" text="waiting for step to complete" />
              <ActivityIndicator size="small" color={theme.colors.background} />
            </View>
          </View>
        )}
      </View>
    )
  }

  // don't show the counter on the last step:
  const showCounter = hasStarted && steps.length > 1 && uiIndex != nonTransitionVideoFiles.length
  const showContent = step.title || step.subtitle || step.info

  if (exitRequested) {
    return null
  }

  return (
    <>
      <View id="main" className="flex-1 justify-between">
        {showHeader && (
          <Header
            leftIcon={showCloseButton && hasStarted ? "x" : undefined}
            MiddleActionComponent={!hasStarted ? <MentraLogoStandalone /> : undefined}
            RightActionComponent={
              hasStarted ? (
                <View className={`flex flex-row gap-2 items-center justify-center`}>
                  {showCounter && <Text className="text-center text-sm font-medium" text={counter} />}
                  <MentraLogoStandalone />
                </View>
              ) : undefined
            }
            onLeftPress={handleClose}
          />
        )}
        <View id="top">
          {showContent && renderStepContent()}
          <View className="-mx-6">
            <Animated.View
              className="relative"
              style={{
                width: "100%",
                aspectRatio: 1,
                opacity: fadeOpacity,
              }}>
              {renderContent()}
            </Animated.View>
            {showReplayButton && isCurrentStepVideo && (
              <View className="absolute bottom-1 left-0 right-0 items-center z-10">
                <Button preset="secondary" className="min-w-24" tx="onboarding:replay" onPress={handleReplay} />
              </View>
            )}
          </View>
          <View className="flex-shrink">{renderStepCheck()}</View>
          {renderBullets()}
          {renderNumberedBullets()}
        </View>

        <View id="bottom" className={`flex justify-end flex-shrink min-h-12`}>
          {!hasStarted && (
            <View className="flex-col">
              <View className="absolute w-full bottom-15 z-10">
                <Button flexContainer text={startButtonText} onPress={handleStart} />
              </View>
              {showSkipButton && <Button preset="secondary" tx="common:skip" onPress={handleSkip} />}
            </View>
          )}

          {hasStarted && (
            <View className="flex-row gap-4">
              {superMode && !isFirstStep && <Button flex preset="secondary" tx="common:back" onPress={handleBack} />}
              {renderContinueButton()}
            </View>
          )}
        </View>
      </View>
    </>
  )
}
