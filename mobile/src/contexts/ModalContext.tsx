/**
 * The Mentra App's one alert surface: a bottom sheet with an optional icon, a title, a message, optional
 * content and stacked buttons. Both `showAlert` here and the older `showAlert` in `@/utils/AlertUtils`
 * present through it.
 *
 * - Alerts queue. One sheet shows at a time, in the order they were asked for. An alert identical to one
 *   already waiting (same title, message and buttons) joins it instead of showing twice: every caller
 *   gets the same answer.
 * - An alert answers once its sheet has slid away, so a button that opens a native surface (a link, a
 *   permission prompt, a picker) never races the sheet.
 * - Swiping the sheet down, tapping outside it and Android back answer with the cancel button, and only
 *   when the alert has one and allows dismissal. Otherwise the sheet waits for a button.
 */
import {StatusBar} from "expo-status-bar"
import {type ReactNode, useCallback, useEffect, useReducer, useRef, useState} from "react"
import {BackHandler, Keyboard, Pressable, ScrollView, type TextStyle, useWindowDimensions, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming} from "react-native-reanimated"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {scheduleOnRN} from "react-native-worklets"

import {Button, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"

export type ButtonStyle = "default" | "cancel" | "destructive"

export interface AlertButton {
  text: string
  style?: ButtonStyle
}

export interface AlertOptions {
  icon?: ReactNode
  content?: ReactNode
  /** Swipe down, tap outside and Android back answer with the cancel button. Needs a cancel button. */
  allowDismiss?: boolean
}

interface AlertRequest {
  title: string
  message?: string
  buttons: AlertButton[]
  options: AlertOptions
}

interface QueuedAlert extends AlertRequest {
  id: number
  /** Everyone who asked for this alert: one caller, plus any identical requests that joined it. */
  waiters: Array<(index: number) => void>
}

/** Identical alerts: the same title, message and buttons. */
const sameAlert = (a: AlertRequest, b: AlertRequest) =>
  a.title === b.title &&
  a.message === b.message &&
  a.buttons.length === b.buttons.length &&
  a.buttons.every((button, index) => button.text === b.buttons[index]!.text && button.style === b.buttons[index]!.style)

const settle = (alert: QueuedAlert, index: number) => alert.waiters.forEach((waiter) => waiter(index))

/** The answer of an alert closed without a button, by `dismissAlert`, or shown with no sheet mounted. */
export const NO_ANSWER = -1

interface AlertHost {
  present: (request: AlertRequest) => Promise<number>
  dismiss: (title: string) => void
}

let host: AlertHost | null = null

/** Whether the sheet is mounted. Before it is (early startup, some tests) callers fall back on their own. */
export const hasAlertHost = () => host !== null

/**
 * Closes the alert titled `title` without running any of its buttons, and drops queued alerts with that
 * title. For alerts whose condition resolved on its own. Their callers get `NO_ANSWER`.
 */
export function dismissAlert(title: string): void {
  host?.dismiss(title)
}

export interface SheetButton {
  button: AlertButton
  /** The button's index in the alert's own list: what the alert answers when it's pressed. */
  index: number
  /** The filled button at the top. */
  primary: boolean
}

/**
 * The sheet's buttons, top to bottom. Callers list buttons dialog-style, with the main action last, so the
 * other buttons go last-first and cancel buttons go to the bottom. The top button is the primary one,
 * unless it's a cancel button among others.
 */
export function sheetButtonOrder(buttons: AlertButton[]): SheetButton[] {
  const indexed = buttons.map((button, index) => ({button, index}))
  const actions = indexed.filter(({button}) => button.style !== "cancel").reverse()
  const cancels = indexed.filter(({button}) => button.style === "cancel")
  return [...actions, ...cancels].map((entry, position) => ({
    ...entry,
    primary: position === 0 && (entry.button.style !== "cancel" || buttons.length === 1),
  }))
}

const SHOW = {duration: 280, easing: Easing.out(Easing.cubic)}
const HIDE = {duration: 220, easing: Easing.in(Easing.cubic)}
/** A drag past this distance or speed answers with cancel; less springs the sheet back. */
const DISMISS_DISTANCE = 96
const DISMISS_VELOCITY = 800
const BUTTON_TEXT: TextStyle = {fontSize: 16}

export function ModalProvider({children}: {children: ReactNode}) {
  const {theme} = useAppTheme()
  const insets = useSafeAreaInsets()
  const {height: windowHeight} = useWindowDimensions()

  const queue = useRef<QueuedAlert[]>([])
  const nextId = useRef(1)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  /** The showing alert's answer while its sheet slides away. */
  const closing = useRef<{id: number; index: number} | null>(null)
  /** Settles the alert that just closed, once React has removed its sheet. */
  const settleAfterCommit = useRef<(() => void) | null>(null)
  const [bodyOverflows, setBodyOverflows] = useState(false)
  const bodyHeights = useRef({viewport: 0, content: 0})

  const offset = useSharedValue(windowHeight)
  const backdrop = useSharedValue(0)

  const current = queue.current[0]
  const cancelIndex = current ? current.buttons.findIndex((button) => button.style === "cancel") : -1
  const dismissible = !!current?.options.allowDismiss && cancelIndex !== -1

  const finish = useCallback(() => {
    const answered = closing.current
    closing.current = null
    const alert = queue.current[0]
    if (!alert || !answered || alert.id !== answered.id) return
    queue.current = queue.current.slice(1)
    settleAfterCommit.current = () => settle(alert, answered.index)
    rerender()
  }, [])

  const close = useCallback(
    (index: number) => {
      const alert = queue.current[0]
      if (!alert || closing.current) return
      closing.current = {id: alert.id, index}
      rerender()
      backdrop.value = withTiming(0, HIDE)
      // Finish however the slide ends: nothing else animates the sheet while it closes.
      offset.value = withTiming(windowHeight, HIDE, () => scheduleOnRN(finish))
    },
    [backdrop, finish, offset, windowHeight],
  )

  const cancel = useCallback(() => {
    const alert = queue.current[0]
    const index = alert ? alert.buttons.findIndex((button) => button.style === "cancel") : -1
    if (alert?.options.allowDismiss && index !== -1) close(index)
  }, [close])

  useEffect(() => {
    const settleClosed = settleAfterCommit.current
    settleAfterCommit.current = null
    settleClosed?.()
  })

  useEffect(() => {
    host = {
      present: (request) =>
        new Promise<number>((answer) => {
          // The showing alert can't be joined once it's answered and closing.
          const waiting = queue.current.filter((alert, position) => !(position === 0 && closing.current))
          const identical = waiting.find((alert) => sameAlert(alert, request))
          if (identical) {
            identical.waiters.push(answer)
            return
          }
          queue.current = [...queue.current, {...request, id: nextId.current++, waiters: [answer]}]
          rerender()
        }),
      dismiss: (title) => {
        const [first, ...rest] = queue.current
        const kept = rest.filter((alert) => {
          if (alert.title !== title) return true
          settle(alert, NO_ANSWER)
          return false
        })
        queue.current = first ? [first, ...kept] : kept
        if (first?.title === title) close(NO_ANSWER)
        else rerender()
      },
    }
    return () => {
      host = null
    }
  }, [close])

  // Slide each alert in. The previous one slid out to the bottom, so the sheet starts there.
  const currentId = current?.id
  useEffect(() => {
    if (currentId === undefined) return
    Keyboard.dismiss()
    bodyHeights.current = {viewport: 0, content: 0}
    setBodyOverflows(false)
    backdrop.value = withTiming(1, SHOW)
    offset.value = withTiming(0, SHOW)
  }, [currentId, backdrop, offset])

  useEffect(() => {
    if (currentId === undefined) return
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      cancel()
      return true
    })
    return () => subscription.remove()
  }, [currentId, cancel])

  const measureBody = (part: "viewport" | "content", height: number) => {
    bodyHeights.current[part] = height
    const {viewport, content} = bodyHeights.current
    const overflows = viewport > 0 && content > viewport + 1
    if (overflows !== bodyOverflows) setBodyOverflows(overflows)
  }

  // A long message scrolls instead of dragging the sheet.
  const drag = Gesture.Pan()
    .enabled(dismissible && !bodyOverflows && !closing.current)
    .activeOffsetY(8)
    .onUpdate((event) => {
      offset.value = Math.max(0, event.translationY)
    })
    .onEnd((event) => {
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
        scheduleOnRN(cancel)
      } else {
        offset.value = withSpring(0, {damping: 22, stiffness: 260})
      }
    })

  const backdropStyle = useAnimatedStyle(() => ({opacity: backdrop.value}))
  const sheetStyle = useAnimatedStyle(() => ({transform: [{translateY: offset.value}]}))

  return (
    <>
      {children}
      {current && (
        <View className="absolute inset-0 z-50" accessibilityViewIsModal>
          <StatusBar style="light" />
          <Animated.View style={backdropStyle} className="absolute inset-0 bg-black/50">
            <Pressable
              className="absolute inset-0"
              onPress={cancel}
              accessible={dismissible}
              accessibilityRole="button"
              accessibilityLabel={translate("common:close")}
              importantForAccessibility={dismissible ? "yes" : "no-hide-descendants"}
              testID="alert.backdrop"
            />
          </Animated.View>
          <GestureDetector gesture={drag}>
            <Animated.View
              key={current.id}
              style={[sheetStyle, {maxHeight: windowHeight * 0.9, paddingBottom: Math.max(insets.bottom, 16) + 8}]}
              className="absolute bottom-0 left-0 right-0 rounded-t-3xl bg-background px-6"
              testID="alert.sheet">
              <View className="h-6 items-center justify-center">
                {dismissible && <View className="h-1.5 w-10 rounded-full bg-border" />}
              </View>
              <ScrollView
                className="grow-0"
                scrollEnabled={bodyOverflows}
                bounces={false}
                showsVerticalScrollIndicator={bodyOverflows}
                onLayout={(event) => measureBody("viewport", event.nativeEvent.layout.height)}
                onContentSizeChange={(_width, height) => measureBody("content", height)}>
                {current.options.icon && <View className="mb-4 mt-2 items-center">{current.options.icon}</View>}
                <Text
                  text={current.title}
                  weight="semibold"
                  accessibilityRole="header"
                  className="text-center text-[22px] leading-7 text-secondary-foreground"
                />
                {!!current.message && (
                  <Text
                    text={current.message}
                    className="mt-2 text-center text-[15px] leading-[21px] text-muted-foreground"
                  />
                )}
                {current.options.content && <View className="mt-4">{current.options.content}</View>}
              </ScrollView>
              <View className="mt-6 gap-2.5">
                {sheetButtonOrder(current.buttons).map(({button, index, primary}) => {
                  const destructive = button.style === "destructive"
                  return (
                    <Button
                      key={index}
                      text={button.text}
                      preset={primary ? (destructive ? "destructive" : "primary") : "alternate"}
                      className="min-h-[50px]"
                      textStyle={[BUTTON_TEXT, destructive && !primary && {color: theme.colors.error}]}
                      disabled={!!closing.current}
                      onPress={() => close(index)}
                    />
                  )
                })}
              </View>
            </Animated.View>
          </GestureDetector>
        </View>
      )}
    </>
  )
}

interface ShowAlertProps {
  title: string
  message?: string
  buttons?: AlertButton[]
  options?: AlertOptions
}

/**
 * Shows an alert sheet and answers with the index of the pressed button, or `NO_ANSWER`. Without
 * options, an alert with a cancel button can be swiped away.
 */
export const showAlert = ({title, message, buttons, options}: ShowAlertProps): Promise<number> => {
  if (!host) return Promise.resolve(NO_ANSWER)
  return host.present({
    title,
    message,
    buttons: buttons?.length ? buttons : [{text: translate("common:ok")}],
    options: options ?? {allowDismiss: true},
  })
}

export default showAlert
