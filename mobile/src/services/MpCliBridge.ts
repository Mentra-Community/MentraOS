/**
 * MP-CLI Bridge Client
 * 
 * Connects MentraOS mobile app to mp-cli HTTP bridge server.
 */

interface ExecuteRequest {
  command: string
  args?: string[]
}

interface ExecuteResponse {
  success: boolean
  data?: any
  error?: string
  execution_time_ms: number
}

interface HealthResponse {
  status: string
  version: string
  uptime: number
}

interface ConnectionStatus {
  bridgeReachable: boolean
  lastPing: string | null
}

class MpCliBridge {
  private static instance: MpCliBridge | null = null
  private bridgeUrl: string = 'http://192.168.0.91:8421/api/v1' // Update with your Mac's IP
  private token: string | null = null

  private constructor() {}

  public static getInstance(): MpCliBridge {
    if (!MpCliBridge.instance) {
      MpCliBridge.instance = new MpCliBridge()
    }
    return MpCliBridge.instance
  }

  /**
   * Set the bridge URL and token
   */
  public configure(bridgeUrl: string, token: string) {
    this.bridgeUrl = bridgeUrl
    this.token = token
    console.log(`[MpCliBridge] Configured: ${bridgeUrl}`)
  }

  /**
   * Check if bridge is reachable
   */
  public async checkConnection(): Promise<ConnectionStatus> {
    try {
      const response = await fetch(`${this.bridgeUrl}/health`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (response.ok) {
        const data: HealthResponse = await response.json()
        console.log(`[MpCliBridge] Health check OK: ${data.status}`)
        return {
          bridgeReachable: true,
          lastPing: new Date().toISOString(),
        }
      }

      return {
        bridgeReachable: false,
        lastPing: null,
      }
    } catch (error) {
      console.error(`[MpCliBridge] Health check failed:`, error)
      return {
        bridgeReachable: false,
        lastPing: null,
      }
    }
  }

  /**
   * Execute a command on the bridge
   */
  public async executeCommand(
    command: string,
    args: string[] = []
  ): Promise<ExecuteResponse> {
    if (!this.token) {
      throw new Error('Bridge not configured. Call configure() first.')
    }

    const startTime = Date.now()

    try {
      console.log(`[MpCliBridge] Executing: mp ${command} ${args.join(' ')}`)

      const response = await fetch(`${this.bridgeUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          command,
          args,
        }),
      })

      const data: ExecuteResponse = await response.json()
      const clientTime = Date.now() - startTime

      console.log(
        `[MpCliBridge] Response: ${data.success ? 'SUCCESS' : 'FAILED'} ` +
        `(server: ${data.execution_time_ms}ms, client: ${clientTime}ms)`
      )

      if (!data.success) {
        console.error(`[MpCliBridge] Error:`, data.error)
      }

      return data
    } catch (error) {
      const clientTime = Date.now() - startTime
      console.error(`[MpCliBridge] Request failed:`, error)
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        execution_time_ms: clientTime,
      }
    }
  }
}

// Export singleton instance
export const mpCliBridge = MpCliBridge.getInstance()
export default mpCliBridge
