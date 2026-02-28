// services/client/feedback.service.ts
// Business logic for managing user feedback

import { Feedback } from "../../models/feedback.model";
import { emailService } from "../email/resend.service";
import { slackService } from "../notifications/slack.service";
import type { FeedbackData } from "../../types/feedback.types";

// Re-export for consumers who import from this service
export type { FeedbackData } from "../../types/feedback.types";

const ADMIN_EMAILS = process.env.ADMIN_EMAILS || "isaiah@mentra.glass";
const admins = [...ADMIN_EMAILS.split(",").map(e => e.trim())];

/**
 * Format feedback data as HTML for email.
 */
function formatFeedbackAsHtml(data: FeedbackData, userEmail: string): string {
  const isBug = data.type === "bug";

  // Header section
  const headerColor = isBug ? "#d32f2f" : "#00b869";
  const headerEmoji = isBug ? "🐛" : "💡";
  const headerTitle = isBug ? "Bug Report" : "Feature Request";

  // Main content
  let mainContent = "";
  if (isBug) {
    const severityColor =
      data.severityRating && data.severityRating >= 4
        ? "#d32f2f"
        : data.severityRating && data.severityRating >= 3
          ? "#ff9800"
          : "#4caf50";
    mainContent = `
      <tr>
        <th width="30%">Expected Behavior</th>
        <td>${escapeHtml(data.expectedBehavior || "")}</td>
      </tr>
      <tr>
        <th>Actual Behavior</th>
        <td>${escapeHtml(data.actualBehavior || "")}</td>
      </tr>
      <tr>
        <th>Severity Rating</th>
        <td style="font-weight: bold; color: ${severityColor};">${data.severityRating || "N/A"}/5</td>
      </tr>`;
  } else {
    const stars = "⭐".repeat(data.experienceRating || 0);
    mainContent = `
      <tr>
        <th width="30%">Feedback</th>
        <td>${escapeHtml(data.feedbackText || "")}</td>
      </tr>
      <tr>
        <th>Experience Rating</th>
        <td style="color: #00b869; font-size: 1.2em;">${stars} ${data.experienceRating || "N/A"}/5</td>
      </tr>`;
  }

  // System info section
  const sys = data.systemInfo || {};
  const contactEmailRow =
    data.contactEmail ? `<tr><th>Contact Email</th><td>${escapeHtml(data.contactEmail)}</td></tr>` : "";
  const runningAppsText =
    sys.runningApps && sys.runningApps.length > 0 ? sys.runningApps.join(", ") : "None";
  const locationText = sys.location
    ? `${sys.location}${sys.locationPlace ? ` (${sys.locationPlace})` : ""}`
    : null;

  const systemInfoHtml = `
    <h3 style="color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">📱 System Information</h3>
    <table>
      ${contactEmailRow}
      <tr><th>App Version</th><td>${escapeHtml(sys.appVersion || "Unknown")}</td></tr>
      <tr><th>Device</th><td>${escapeHtml(sys.deviceName || "Unknown")}</td></tr>
      <tr><th>OS</th><td>${escapeHtml(sys.osVersion || "Unknown")}</td></tr>
      <tr><th>Platform</th><td>${escapeHtml(sys.platform || "Unknown")}</td></tr>
      <tr><th>Glasses Connected</th><td>${sys.glassesConnected ? "Yes" : "No"}</td></tr>
      <tr><th>Default Wearable</th><td>${escapeHtml(sys.defaultWearable || "Unknown")}</td></tr>
      <tr><th>Running Apps</th><td>${escapeHtml(runningAppsText)}</td></tr>
      <tr><th>Offline Mode</th><td>${sys.offlineMode ? "Yes" : "No"}</td></tr>
      <tr><th>Network Type</th><td>${escapeHtml(sys.networkType || "Unknown")}</td></tr>
      <tr><th>Network Connected</th><td>${sys.networkConnected ? "Yes" : "No"}</td></tr>
      <tr><th>Internet Reachable</th><td>${sys.internetReachable ? "Yes" : "No"}</td></tr>
      ${locationText ? `<tr><th>Location</th><td>${escapeHtml(locationText)}</td></tr>` : ""}
      ${sys.isBetaBuild ? `<tr><th>Beta Build</th><td>Yes</td></tr>` : ""}
      ${sys.isBetaBuild && sys.backendUrl ? `<tr><th>Backend URL</th><td>${escapeHtml(sys.backendUrl)}</td></tr>` : ""}
      <tr><th>Build Commit</th><td>${escapeHtml(sys.buildCommit || "Unknown")}</td></tr>
      <tr><th>Build Branch</th><td>${escapeHtml(sys.buildBranch || "Unknown")}</td></tr>
      <tr><th>Build Time</th><td>${escapeHtml(sys.buildTime || "Unknown")}</td></tr>
      <tr><th>Build User</th><td>${escapeHtml(sys.buildUser || "Unknown")}</td></tr>
    </table>`;

  // Glasses info section
  let glassesInfoHtml = "";
  if (data.glassesInfo && data.systemInfo?.glassesConnected) {
    const g = data.glassesInfo;
    glassesInfoHtml = `
    <h3 style="color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">🕶️ Glasses Information</h3>
    <table>
      <tr><th>Model</th><td>${escapeHtml(g.modelName || "Unknown")}</td></tr>
      ${g.bluetoothId ? `<tr><th>Device ID</th><td>${escapeHtml(g.bluetoothId)}</td></tr>` : ""}
      ${g.serialNumber ? `<tr><th>Serial Number</th><td>${escapeHtml(g.serialNumber)}</td></tr>` : ""}
      ${g.buildNumber ? `<tr><th>Build Number</th><td>${escapeHtml(g.buildNumber)}</td></tr>` : ""}
      ${g.fwVersion ? `<tr><th>Firmware Version</th><td>${escapeHtml(g.fwVersion)}</td></tr>` : ""}
      ${g.appVersion ? `<tr><th>Glasses App Version</th><td>${escapeHtml(g.appVersion)}</td></tr>` : ""}
      ${g.androidVersion ? `<tr><th>Android Version</th><td>${escapeHtml(g.androidVersion)}</td></tr>` : ""}
      <tr><th>WiFi Connected</th><td>${g.wifiConnected ? "Yes" : "No"}</td></tr>
      ${g.wifiConnected && g.wifiSsid ? `<tr><th>WiFi Network</th><td>${escapeHtml(g.wifiSsid)}</td></tr>` : ""}
      ${g.batteryLevel !== undefined && g.batteryLevel >= 0 ? `<tr><th>Battery Level</th><td>${g.batteryLevel}%</td></tr>` : ""}
    </table>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    h2 { color: ${headerColor}; border-bottom: 2px solid ${headerColor}; padding-bottom: 10px; }
    h3 { color: #666; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; border: 1px solid #ddd; }
    td { padding: 12px; border: 1px solid #ddd; }
  </style>
</head>
<body>
  <div class="container">
    <h2>${headerEmoji} ${headerTitle}</h2>
    <p><strong>From:</strong> ${escapeHtml(userEmail)}</p>
    <table>
      ${mainContent}
    </table>
    ${systemInfoHtml}
    ${glassesInfoHtml}
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Submit user feedback.
 * Accepts either legacy string format or new structured format.
 */
export async function submitFeedback(
  email: string,
  feedback: string | FeedbackData,
) {
  // Determine if this is legacy (string) or new (object) format
  const isStructured = typeof feedback === "object";

  // For database storage, serialize structured data to JSON string
  const feedbackString = isStructured ? JSON.stringify(feedback) : feedback;

  // Save feedback to database
  const newFeedback = await Feedback.create({
    email,
    feedback: feedbackString,
  });

  // Format for email
  const emailHtml = isStructured
    ? formatFeedbackAsHtml(feedback, email)
    : `<p>${escapeHtml(feedback)}</p>`;

  // Submit feedback to admin emails using mail service
  await emailService.sendFeedback(email, emailHtml, admins);

  // Send feedback to Slack channel (fire-and-forget to not delay API response)
  if (isStructured) {
    slackService.notifyUserFeedback(email, feedback).catch(() => {});
  } else {
    // Legacy format - just send as plain text
    slackService.notifyUserFeedbackLegacy(email, feedback).catch(() => {});
  }

  return newFeedback;
}
