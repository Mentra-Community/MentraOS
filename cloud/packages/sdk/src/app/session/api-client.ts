/**
 * 🔌 API Client Module
 *
 * Provides HTTP API access to MentraOS Cloud services.
 * Automatically uses the correct server URL derived from the WebSocket URL.
 */

/**
 * Convert a WebSocket URL to a HTTP/HTTPS URL
 *
 * @param wsUrl WebSocket URL to convert
 * @returns HTTP URL equivalent
 */
export function wsUrlToHttpUrl(wsUrl?: string): string | undefined {
  if (!wsUrl) return undefined;

  try {
    // Parse the WebSocket URL
    const url = new URL(wsUrl);

    // Change protocol from ws/wss to http/https
    const protocol = url.protocol === "wss:" ? "https:" : "http:";

    // Recreate the URL with the new protocol
    return `${protocol}//${url.host}`;
  } catch (error) {
    console.error("Error converting WebSocket URL to HTTP URL:", error);
    return undefined;
  }
}

/**
 * API client class for making HTTP requests to MentraOS Cloud
 */
export class ApiClient {
  private baseUrl: string | undefined;
  private packageName: string;
  private userId: string | undefined;

  /**
   * Create a new API client
   *
   * @param packageName App package name
   * @param wsUrl WebSocket URL (optional, can be set later)
   * @param userId User ID (optional, for authenticated requests)
   */
  constructor(packageName: string, wsUrl?: string, userId?: string) {
    this.packageName = packageName;
    this.userId = userId;

    if (wsUrl) {
      this.baseUrl = wsUrlToHttpUrl(wsUrl);
    }
  }

  /**
   * Set the WebSocket URL to derive the HTTP base URL
   *
   * @param wsUrl WebSocket URL
   */
  setWebSocketUrl(wsUrl: string): void {
    this.baseUrl = wsUrlToHttpUrl(wsUrl);
  }

  /**
   * Set the user ID for authenticated requests
   *
   * @param userId User ID
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * Fetch settings from MentraOS Cloud
   *
   * @returns Promise resolving to settings array
   * @throws Error if client is not configured correctly or if request fails
   */
  async fetchSettings(): Promise<any[]> {
    if (!this.baseUrl) {
      throw new Error("API client is not configured with a base URL");
    }

    if (!this.userId) {
      throw new Error("User ID is required for fetching settings");
    }

    const url = `${this.baseUrl}/appsettings/user/${this.packageName}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.userId}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch settings: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as { settings: any[] };
      return data.settings || [];
    } catch (error) {
      console.error("Error fetching settings:", error);
      throw error;
    }
  }
}
