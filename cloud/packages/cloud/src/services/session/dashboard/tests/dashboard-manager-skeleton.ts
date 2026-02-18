/**
 * Dashboard Manager App Implementation
 *
 * This is a complete implementation of the dashboard-manager App
 * using the new Dashboard API. It maintains backward compatibility
 * with the existing system.
 */
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { AppSession, StreamType, DashboardMode } from "@mentra/sdk";
// Inline wrapText utility (previously from @mentra/utils)
function wrapText(text: any, maxLength = 25): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => {
      const words = line.split(" ");
      let currentLine = "";
      const wrappedLines: string[] = [];

      words.forEach((word) => {
        if (
          currentLine.length + (currentLine ? 1 : 0) + word.length <=
          maxLength
        ) {
          currentLine += (currentLine ? " " : "") + word;
        } else {
          if (currentLine) {
            wrappedLines.push(currentLine);
          }
          currentLine = word;

          // If a single word is too long, hardcut it.
          while (currentLine.length > maxLength) {
            wrappedLines.push(currentLine.slice(0, maxLength));
            currentLine = currentLine.slice(maxLength);
          }
        }
      });

      if (currentLine) {
        wrappedLines.push(currentLine.trim());
      }

      return wrappedLines.join("\n");
    })
    .join("\n");
}
import { tzlookup } from "tz-lookup";
import { logger } from "../../../../services/logging/pino-logger";

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;
const CLOUD_HOST_NAME = process.env.CLOUD_LOCAL_HOST_NAME || "cloud";
const PACKAGE_NAME =
  process.env.SYSTEM_DASHBOARD_PACKAGE_NAME || "system.augmentos.dashboard";
const API_KEY = process.env.AUGMENTOS_AUTH_JWT_SECRET;

if (!API_KEY) {
  logger.error(
    "API_KEY is not set. Please set the AUGMENTOS_AUTH_JWT_SECRET environment variable.",
  );
  process.exit(1);
}

// Express app setup
const app = express();
app.use(express.json());

// List of notification app names to ignore
const notificationAppBlackList = ["youtube", "augment", "maps"];

// Session information interface
interface SessionInfo {
  userId: string;
  session: AppSession;
  batteryLevel?: number;
  latestLocation?: { latitude: number; longitude: number; timezone?: string };
  phoneNotificationCache?: {
    title: string;
    content: string;
    timestamp: number;
    uuid: string;
  }[];
  phoneNotificationRanking?: any[];
  calendarEvent?: any;
  weatherCache?: { timestamp: number; data: string };
  dashboardMode: DashboardMode;
  currentSettings?: any;
}

const activeSessions = new Map<string, SessionInfo>();

// ===================================
// Main Webhook Endpoint
// ===================================

app.post("/webhook", async (req: express.Request, res: express.Response) => {
  try {
    const { sessionId, userId } = req.body;
    logger.info(`Session start for user ${userId}, session ${sessionId}`);

    // Create App session
    const session = new AppSession({
      packageName: PACKAGE_NAME,
      apiKey: API_KEY,
      augmentOSWebsocketUrl: `ws://${CLOUD_HOST_NAME}/app-ws`,
    });

    // Store session info
    activeSessions.set(sessionId, {
      userId,
      session,
      phoneNotificationCache: [],
      dashboardMode: DashboardMode.MAIN,
    });

    // Connect to cloud
    await session.connect(sessionId);
    logger.info(`Connected to AugmentOS Cloud`);

    // Set up event handlers
    setupEventHandlers(sessionId, session);

    // Initialize dashboard
    initializeDashboard(sessionId);

    // Respond to webhook
    res.status(200).json({ status: "connected" });
  } catch (error) {
    logger.error("Error handling webhook", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================
// Event Handlers Setup
// ===================================

function setupEventHandlers(sessionId: string, session: AppSession): void {
  // Handle connection events
  session.events.on("connected", () => {
    logger.info(`Session ${sessionId} connected`);

    // Subscribe to necessary streams
    session.subscribe(StreamType.PHONE_NOTIFICATION);
    session.subscribe(StreamType.LOCATION_UPDATE);
    session.subscribe(StreamType.HEAD_POSITION);
    session.subscribe(StreamType.GLASSES_BATTERY_UPDATE);
    session.subscribe(StreamType.CALENDAR_EVENT);
  });

  // Handle phone notifications
  session.on(StreamType.PHONE_NOTIFICATION, (data) => {
    handlePhoneNotification(sessionId, data);
  });

  // Handle phone notification dismissals
  session.on(StreamType.PHONE_NOTIFICATION_DISMISSED, (data) => {
    handlePhoneNotificationDismissed(sessionId, data);
  });

  // Handle location updates
  session.on(StreamType.LOCATION_UPDATE, (data) => {
    handleLocationUpdate(sessionId, data);
  });

  // Handle head position
  session.on(StreamType.HEAD_POSITION, (data) => {
    handleHeadPosition(sessionId, data);
  });

  // Handle battery updates
  session.on(StreamType.GLASSES_BATTERY_UPDATE, (data) => {
    handleBatteryUpdate(sessionId, data);
  });

  // Handle calendar events
  session.on(StreamType.CALENDAR_EVENT, (data) => {
    handleCalendarEvent(sessionId, data);
  });

  // Handle dashboard mode changes
  session.dashboard.content.onModeChange((mode) => {
    const sessionInfo = activeSessions.get(sessionId);
    if (sessionInfo && mode !== "none") {
      sessionInfo.dashboardMode = mode;
      logger.info(`Dashboard mode changed to ${mode} for session ${sessionId}`);
      updateDashboardSections(sessionId);
    }
  });

  // Handle disconnection
  session.events.on("disconnected", (reason) => {
    logger.info(`Session ${sessionId} disconnected: ${reason}`);
    const sessionInfo = activeSessions.get(sessionId);

    // Clean up any intervals for this session
    if (sessionInfo) {
      // Clean up resources
    }

    activeSessions.delete(sessionId);
  });
}

// ===================================
// Dashboard Initialization
// ===================================

function initializeDashboard(sessionId: string): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Set dashboard to main mode
  sessionInfo.session.dashboard.system?.setViewMode(DashboardMode.MAIN);
  sessionInfo.dashboardMode = DashboardMode.MAIN;

  // Initialize system sections
  updateDashboardSections(sessionId);

  // Schedule periodic updates (every minute)
  setInterval(() => updateDashboardSections(sessionId), 60000);
}

// ===================================
// Dashboard Updating Functions
// ===================================

function updateDashboardSections(sessionId: string): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Format time section
  const timeText = formatTimeSection(sessionInfo);
  sessionInfo.session.dashboard.system?.setTopLeft(timeText);

  // Format battery section
  const batteryText = formatBatterySection(sessionInfo);
  sessionInfo.session.dashboard.system?.setTopRight(batteryText);

  // Format notification section
  const notificationText = formatNotificationSection(sessionInfo);
  sessionInfo.session.dashboard.system?.setBottomLeft(notificationText);

  // Format status section
  const statusText = formatStatusSection(sessionInfo);
  sessionInfo.session.dashboard.system?.setBottomRight(statusText);
}

// ===================================
// Section Formatters
// ===================================

function formatTimeSection(sessionInfo: SessionInfo): string {
  // Check if we have a valid timezone from location
  if (!sessionInfo.latestLocation?.timezone) {
    return "◌ $DATE$, $TIME12$";
  }

  try {
    const timezone = sessionInfo.latestLocation.timezone;
    const options = {
      timeZone: timezone,
      hour: "2-digit" as const,
      minute: "2-digit" as const,
      month: "numeric" as const,
      day: "numeric" as const,
      hour12: true,
    };
    let formatted = new Date().toLocaleString("en-US", options);
    formatted = formatted.replace(/ [AP]M/, "");
    return `◌ ${formatted}`;
  } catch (error) {
    logger.error(`Error formatting time:`, error);
    return "◌ $DATE$, $TIME12$";
  }
}

function formatBatterySection(sessionInfo: SessionInfo): string {
  return typeof sessionInfo.batteryLevel === "number"
    ? `${sessionInfo.batteryLevel}%`
    : "$GBATT$";
}

function formatNotificationSection(sessionInfo: SessionInfo): string {
  // Use ranked notifications if available, otherwise use the raw cache
  const notifications =
    sessionInfo.phoneNotificationRanking ||
    sessionInfo.phoneNotificationCache ||
    [];

  if (notifications.length === 0) return "";

  // Take the latest 2 notifications
  const topNotifications = notifications.slice(0, 2);

  // Format differently based on whether we're using ranked or raw notifications
  if (sessionInfo.phoneNotificationRanking) {
    return topNotifications
      .map((notification) => wrapText(notification.summary, 25))
      .join("\n");
  } else {
    return topNotifications
      .map((notification) => `${notification.title}: ${notification.content}`)
      .join("\n");
  }
}

function formatStatusSection(sessionInfo: SessionInfo): string {
  // Prioritize calendar events if available
  if (sessionInfo.calendarEvent) {
    return formatCalendarEvent(sessionInfo.calendarEvent);
  }

  // Then weather if available
  if (sessionInfo.weatherCache) {
    return sessionInfo.weatherCache.data;
  }

  // Default status
  return "Status: Connected";
}

function formatCalendarEvent(event: any): string {
  try {
    const eventDate = new Date(event.dtStart);
    const formattedTime = eventDate
      .toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .replace(" ", "");

    const title =
      event.title.length > 10
        ? event.title.substring(0, 10).trim() + "..."
        : event.title;

    return `${title} @ ${formattedTime}`;
  } catch (error) {
    logger.error("Error formatting calendar event", error);
    return "Calendar event";
  }
}

// ===================================
// Event Handlers
// ===================================

function handlePhoneNotification(sessionId: string, data: any): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Initialize notification cache if needed
  if (!sessionInfo.phoneNotificationCache) {
    sessionInfo.phoneNotificationCache = [];
  }

  // Check if the app name is blacklisted
  if (
    data.app &&
    notificationAppBlackList.some((app) => data.app.toLowerCase().includes(app))
  ) {
    logger.debug(`Notification from ${data.app} is blacklisted.`);
    return;
  }

  // Add notification to cache
  const newNotification = {
    title: data.title || "No Title",
    content: data.content || "",
    timestamp: Date.now(),
    uuid: uuidv4(),
  };

  // Prevent duplicate notifications
  const cache = sessionInfo.phoneNotificationCache;
  if (cache.length > 0) {
    const lastNotification = cache[cache.length - 1];
    if (
      lastNotification.title === newNotification.title &&
      lastNotification.content === newNotification.content
    ) {
      logger.debug(`Duplicate notification detected. Not adding to cache.`);
      return;
    }
  }

  // Add to cache
  sessionInfo.phoneNotificationCache.push(newNotification);

  // Process notifications
  processNotifications(sessionId);
}

function handlePhoneNotificationDismissed(sessionId: string, data: any): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  logger.debug(`Phone notification dismissed for session ${sessionId}:`, data);

  // Extract notification ID from dismissal data
  const dismissedNotificationId = data.notificationId;
  if (!dismissedNotificationId) {
    logger.warn(`Dismissal event missing notificationId:`, data);
    return;
  }

  // Remove the dismissed notification from cache if it exists
  if (
    sessionInfo.phoneNotificationCache &&
    sessionInfo.phoneNotificationCache.length > 0
  ) {
    const initialCacheSize = sessionInfo.phoneNotificationCache.length;

    // Filter out the dismissed notification by matching notificationId
    sessionInfo.phoneNotificationCache =
      sessionInfo.phoneNotificationCache.filter(
        (notification) => notification.uuid !== dismissedNotificationId,
      );

    const removedCount =
      initialCacheSize - sessionInfo.phoneNotificationCache.length;
    if (removedCount > 0) {
      logger.info(
        `Removed ${removedCount} dismissed notification(s) from cache for session ${sessionId}`,
      );
    } else {
      logger.debug(
        `No matching notification found in cache for dismissal ID: ${dismissedNotificationId}`,
      );
    }
  }

  // Re-process notifications to update ranking
  processNotifications(sessionId);

  // Update dashboard to reflect the dismissal
  updateDashboardSections(sessionId);
}

function processNotifications(sessionId: string): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo || !sessionInfo.phoneNotificationCache) return;

  // For now, we'll just use a simple ranking algorithm
  // In a full implementation, we would use the NotificationSummaryAgent
  sessionInfo.phoneNotificationRanking = sessionInfo.phoneNotificationCache
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((notification) => ({
      summary: `${notification.title}: ${notification.content}`,
      timestamp: notification.timestamp,
    }));

  updateDashboardSections(sessionId);
}

function handleLocationUpdate(sessionId: string, data: any): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Extract lat, lng from location data
  const { lat, lng } = data;

  // Skip if invalid coordinates
  if (typeof lat !== "number" || typeof lng !== "number") {
    logger.error(`Invalid location data:`, data);
    return;
  }

  // Update location in session
  sessionInfo.latestLocation = {
    latitude: lat,
    longitude: lng,
    timezone:
      determineTimezone(lat, lng) || sessionInfo.latestLocation?.timezone,
  };

  // Update dashboard with location info
  updateDashboardSections(sessionId);
}

function handleHeadPosition(sessionId: string, data: any): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Update dashboard on "up" position
  if (data.position === "up") {
    updateDashboardSections(sessionId);
  }
}

function handleBatteryUpdate(sessionId: string, data: any): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Update battery level if it changed
  if (
    typeof data.level === "number" &&
    sessionInfo.batteryLevel !== data.level
  ) {
    sessionInfo.batteryLevel = data.level;
    updateDashboardSections(sessionId);
  }
}

function handleCalendarEvent(sessionId: string, event: any): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;

  // Validate event structure
  if (!event.title || !event.dtStart) {
    logger.error(`Invalid calendar event structure:`, event);
    return;
  }

  // Update calendar event
  sessionInfo.calendarEvent = event;
  updateDashboardSections(sessionId);
}

// ===================================
// Settings Handling
// ===================================

app.post("/settings", async (req: express.Request, res: express.Response) => {
  try {
    const { userIdForSettings } = req.body;
    logger.info("Received settings update for dashboard:", req.body);

    // Find all sessions for this user and update settings
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.userId === userIdForSettings) {
        session.currentSettings = req.body;
        updateDashboardSections(sessionId);
      }
    }

    res.status(200).json({ status: "settings updated" });
  } catch (error) {
    logger.error("Error updating settings:", error);
    res.status(500).json({ error: "Internal server error updating settings" });
  }
});

// ===================================
// Utility Functions
// ===================================

function determineTimezone(lat: number, lng: number): string | undefined {
  try {
    // Call tzlookup to get timezone from coordinates
    return tzlookup(lat, lng);
  } catch (error) {
    logger.error(
      `Error looking up timezone for lat=${lat}, lng=${lng}:`,
      error,
    );
    return undefined;
  }
}

// ===================================
// Server Setup
// ===================================

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    app: PACKAGE_NAME,
    sessions: activeSessions.size,
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Dashboard Manager App running on port ${PORT}`);
});

// Schedule periodic dashboard updates for all sessions
setInterval(() => {
  for (const sessionId of activeSessions.keys()) {
    updateDashboardSections(sessionId);
  }
}, 60000);
