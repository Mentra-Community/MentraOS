// LogService.ts
import {NativeModules, Platform} from "react-native"
import BackendServerComms from "../backend_comms/BackendServerComms"

const {LogcatCapture} = NativeModules

// This is a simple stub for iOS - actual iOS implementation will be added in the future
class LogService {
  private static instance: LogService
  private TAG = "MXT2_LogService"
  private backendComms: BackendServerComms

  private constructor() {
    this.backendComms = BackendServerComms.getInstance()
  }

  public static getInstance(): LogService {
    if (!LogService.instance) {
      LogService.instance = new LogService()
    }
    return LogService.instance
  }

  /**
   * Gets device logs
   * @param lines Number of log lines to retrieve
   * @returns Promise with log data
   */
  public async getLogs(lines: number = 1000): Promise<string> {
    try {
      if (Platform.OS === "android" && LogcatCapture) {
        return await LogcatCapture.getLogs(lines)
      } else {
        // Stub for iOS - to be implemented in the future
        console.warn(`${this.TAG}: Log module not available on iOS yet`)
        return "Log capture is not yet available on iOS"
      }
    } catch (error) {
      console.error(`${this.TAG}: Error getting logs -`, error)
      return `Error retrieving logs: ${error}`
    }
  }

  /**
   * Clears device logs
   * @returns Promise<boolean>
   */
  public async clearLogs(): Promise<boolean> {
    try {
      if (Platform.OS === "android" && LogcatCapture) {
        return await LogcatCapture.clearLogs()
      } else {
        // Stub for iOS - to be implemented in the future
        console.warn(`${this.TAG}: Log clearing not available on iOS yet`)
        return false
      }
    } catch (error) {
      console.error(`${this.TAG}: Error clearing logs -`, error)
      return false
    }
  }

  /**
   * Send error report to backend server
   * @param description User-provided description of the issue
   * @returns Promise<boolean> Success status
   */
  public async sendErrorReport(description: string): Promise<boolean> {
    try {
      // Get logs
      const logs = await this.getLogs()

      // Prepare data for report
      const reportData = {
        description,
        logs,
        deviceInfo: {
          platform: Platform.OS,
          version: Platform.Version,
        },
        timestamp: new Date().toISOString(),
      }

      // Use the dedicated method in BackendServerComms
      await this.backendComms.sendErrorReport(reportData)
      return true
    } catch (error) {
      console.error(`${this.TAG}: Error sending report -`, error)
      return false
    }
  }
}

export default LogService
