import {useEffect, useState} from "react"
import {AppState, Platform, View} from "react-native"
import type {NativeNotificationStatus} from "@mentra/bluetooth-sdk"
import {engine, SETTINGS, useSetting} from "@mentra/engine"

import {Button, Text} from "@/components/ignite"
import {translate} from "@/i18n"
import NumberSetting from "./NumberSetting"
import ToggleSetting from "./ToggleSetting"

export default function NativeNotificationSettings() {
  const [connection, setConnection] = useState(engine.glasses.status)
  const [model, setModel] = useState(() => engine.glasses.info().model)
  useEffect(() => {
    const unsubscribeStatus = engine.glasses.onStatus(setConnection)
    const unsubscribeInfo = engine.glasses.onInfo((info) => setModel(info.model))
    return () => {
      unsubscribeStatus()
      unsubscribeInfo()
    }
  }, [])
  const [enabled, setEnabled] = useSetting(SETTINGS.native_notifications_enabled.key)
  const [autoDisplay, setAutoDisplay] = useSetting(SETTINGS.native_notifications_auto_display.key)
  const [duration, setDuration] = useSetting(SETTINGS.native_notifications_duration.key)
  const [doNotDisturb, setDoNotDisturb] = useSetting(SETTINGS.native_notifications_do_not_disturb.key)
  const [status, setStatus] = useState<NativeNotificationStatus | null>(null)
  const [listenerPermission, setListenerPermission] = useState(false)
  const capabilities = engine.phoneNotifications.nativeCapabilities()

  useEffect(() => {
    let active = true
    let revision = 0
    setStatus(null)
    const refresh = async () => {
      const requestRevision = ++revision
      try {
        const [native, granted] = await Promise.all([
          engine.phoneNotifications.nativeStatus(),
          engine.phoneNotifications.hasListenerPermission(),
        ])
        if (active) {
          if (requestRevision === revision) setStatus(native)
          setListenerPermission(granted)
        }
      } catch {
        if (active) setStatus(null)
      }
    }
    void refresh()
    const unsubscribe = engine.phoneNotifications.onNativeStatus((next) => {
      if (active) {
        revision++
        setStatus(next)
      }
    })
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh()
    })
    return () => {
      active = false
      unsubscribe()
      appState.remove()
    }
  }, [model, connection, enabled])

  if (!capabilities.supported) {
    return Platform.OS === "ios" ? (
      <Text tx="settings:nativeNotificationsRequiresG2" className="p-4 text-muted-foreground" />
    ) : null
  }

  return (
    <View className="gap-3 p-4">
      <ToggleSetting
        label={translate("settings:nativeNotificationsTitle")}
        subtitle={translate("settings:nativeNotificationsDescription")}
        value={enabled}
        onValueChange={setEnabled}
      />
      {enabled && (
        <>
          <ToggleSetting
            label={translate("settings:nativeNotificationsPopups")}
            subtitle={translate("settings:nativeNotificationsHistory")}
            value={autoDisplay}
            onValueChange={setAutoDisplay}
          />
          <NumberSetting
            label={translate("settings:nativeNotificationsDuration")}
            value={duration}
            min={1}
            max={30}
            step={1}
            onValueChange={(value) => setDuration(Math.round(value))}
          />
          <ToggleSetting
            label={translate("settings:nativeNotificationsDnd")}
            value={doNotDisturb}
            onValueChange={setDoNotDisturb}
          />
          {connection.state !== "connected" || status?.state === "unavailable" || !status?.supported ? (
            <Text tx="settings:nativeNotificationsConnect" className="text-muted-foreground" />
          ) : null}
          {status?.state === "needs_reconnect" && (
            <Text accessibilityRole="alert" tx="settings:nativeNotificationsReconnect" />
          )}
          {status?.state === "failed" && <Text accessibilityRole="alert" tx="settings:nativeNotificationsFailed" />}
          {Platform.OS === "ios" ? (
            <>
              <Text tx="settings:nativeNotificationsIosContent" className="text-muted-foreground" />
              {status?.authorization !== "authorized" && (
                <Text tx="settings:nativeNotificationsAncs" className="text-muted-foreground" />
              )}
              <Text tx="settings:nativeNotificationsIosFilters" className="text-muted-foreground" />
            </>
          ) : (
            <>
              {!listenerPermission && (
                <Button
                  tx="settings:nativeNotificationsGrantAccess"
                  onPress={() => engine.phoneNotifications.requestListenerPermission()}
                />
              )}
              <Text tx="settings:nativeNotificationsRemoval" className="text-muted-foreground" />
            </>
          )}
        </>
      )}
    </View>
  )
}
