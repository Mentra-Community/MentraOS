import React, {useEffect, ReactNode} from "react"

interface NotificationListenerProps {
  children: ReactNode
}

const NotificationListener: React.FC<NotificationListenerProps> = ({children}) => {
  // does nothing on ios:
  // Render children to wrap the main app
  return <>{children}</>
}

export default NotificationListener
