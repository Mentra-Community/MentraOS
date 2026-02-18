/**
 * MP-CLI App Manager
 * Monitors the mp_cli_running setting and starts/stops the dashboard
 */

import {useEffect} from 'react'
import {SETTINGS, useSetting} from '@/stores/settings'
import DashboardManager from '@/services/DashboardManager'

const dashboardManager = DashboardManager.getInstance();

export function MpCliAppManager() {
  const [mpCliRunning] = useSetting(SETTINGS.mp_cli_running.key)

  console.log('[MpCliAppManager] Mounted, mp_cli_running:', mpCliRunning);

  useEffect(() => {
    console.log('[MpCliAppManager] mp_cli_running changed to:', mpCliRunning);
    if (mpCliRunning) {
      console.log('[MpCliAppManager] Starting Dashboard')
      dashboardManager.start()
    } else {
      console.log('[MpCliAppManager] Stopping Dashboard')
      dashboardManager.stop()
    }

    // Cleanup on unmount
    return () => {
      dashboardManager.stop()
    }
  }, [mpCliRunning])

  return null // This is a headless component
}
