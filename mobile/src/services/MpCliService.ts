/**
 * MP-CLI Service
 * Manages the MP-CLI Dashboard offline app
 * Fetches data from mp-cli server and displays on glasses
 */

import {mpCliBridge} from './MpCliBridge'
import miniComms from './MiniComms'
import DisplayFormatter from './DisplayFormatter'
import {SETTINGS, useSettingsStore} from '@/stores/settings'
import {BackgroundTimer} from '@/utils/timers'

class MpCliService {
  private refreshInterval: ReturnType<typeof BackgroundTimer.setInterval> | null = null
  private readonly REFRESH_INTERVAL_MS = 60000 // 1 minute

  /**
   * Start the MP-CLI service
   */
  async start() {
    console.log('[MpCliService] Starting...')
    
    // Configure bridge (TODO: get from settings)
    mpCliBridge.configure(
      'http://192.168.0.91:8421/api/v1',
      '3l2LMHhjg5BH-XJfon0VmqIkhA1ZA9Dv1FWVnsxcbXU'
    )

    // Initial fetch
    await this.fetchAndDisplay()

    // Set up periodic refresh
    this.refreshInterval = BackgroundTimer.setInterval(() => {
      this.fetchAndDisplay()
    }, this.REFRESH_INTERVAL_MS)

    console.log('[MpCliService] Started with refresh interval:', this.REFRESH_INTERVAL_MS)
  }

  /**
   * Stop the MP-CLI service
   */
  stop() {
    console.log('[MpCliService] Stopping...')
    
    if (this.refreshInterval) {
      BackgroundTimer.clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }

    console.log('[MpCliService] Stopped')
  }

  /**
   * Fetch data from mp-cli and display on glasses
   */
  private async fetchAndDisplay() {
    try {
      console.log('[MpCliService] Fetching data...')
      
      const response = await mpCliBridge.executeCommand('next')
      
      if (response.success && response.data) {
        const formatted = DisplayFormatter.formatNext(response.data)
        miniComms.sendToGlasses(formatted)
        console.log('[MpCliService] Sent to glasses:', formatted.substring(0, 50) + '...')
      } else {
        console.error('[MpCliService] Failed to fetch:', response.error)
      }
    } catch (error) {
      console.error('[MpCliService] Error:', error)
    }
  }

  /**
   * Manual refresh (called by button press, etc.)
   */
  async refresh() {
    console.log('[MpCliService] Manual refresh triggered')
    await this.fetchAndDisplay()
  }
}

export const mpCliService = new MpCliService()
