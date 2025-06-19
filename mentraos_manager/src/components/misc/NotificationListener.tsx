import React, {useEffect, ReactNode} from "react"
import {NativeEventEmitter, NativeModules, Alert} from "react-native"

const {NotificationModule} = NativeModules
const notificationEmitter = new NativeEventEmitter(NotificationModule)

interface NotificationListenerProps {
  children: ReactNode
}

const NotificationListener: React.FC<NotificationListenerProps> = ({children}) => {
  useEffect(() => {
    // Listen for notifications from the native module
    const subscription = notificationEmitter.addListener("onNotificationReceived", (notificationText: string) => {
      // Display or handle the notification
      Alert.alert("New Notification", notificationText)
      console.log("Received notification:", notificationText)
    })

    // Clean up the listener on unmount
    return () => subscription.remove()
  }, [])

  // Render children to wrap the main app
  return <>{children}</>
}

export default NotificationListener
