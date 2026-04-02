/**
 * NotificationService
 *
 * Cloud-side replacement for the Dashboard mini app's NotificationSummaryAgent.
 * Maintains a cache of phone notifications, ranks them via OpenAI, and exposes
 * a `getDisplayText()` method that returns the top-2 ranked items for HUD display.
 *
 * Display format: "[AppName] summary" — e.g. "[Gmail] OpenAI: Excel plugin down"
 * Each notification gets a full line (~40 chars on G1 display).
 *
 * No LangChain — uses the `openai` npm package directly.
 */

import { Logger } from "pino";
import OpenAI from "openai";

import { logger as rootLogger } from "../../logging/pino-logger";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PhoneNotification {
  uuid: string;
  title: string;
  content: string;
  appName?: string;
  timestamp: number;
  viewCount: number;
}

export interface RankedNotification {
  uuid: string;
  summary: string;
  appName: string;
  rank: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of notifications held in the cache at one time. */
const MAX_CACHE_SIZE = 20;

/** Notifications viewed more than this many times are pruned as stale. */
const MAX_VIEW_COUNT = 10;

/** Number of ranked notifications surfaced in `getDisplayText()`. */
const DISPLAY_TOP_N = 2;

/**
 * Max characters for the summary portion (after "[AppName] ").
 * G1 display is ~40 chars wide; "[Gmail] " is 8 chars → 32 left for summary.
 * We allow up to 35 for the summary since some app names are shorter.
 */
const MAX_SUMMARY_CHARS = 35;

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const RANKING_SYSTEM_PROMPT = `You are a smart glasses notification filter. The user wears glasses with a small HUD that shows 2 lines of text. Each line is formatted as "[AppName] summary" where AppName is already handled — you only write the summary part.

Your job:
1. Rank notifications by importance (rank 1 = most important).
2. Write a SHORT summary (max ${MAX_SUMMARY_CHARS} chars) that captures the key info.

Rules for summaries:
- Lead with the most important detail: WHO or WHAT, not the app name (app name is shown separately).
- Use first names only for people: "Alex: let's sync" not "Alexander Smith sent: let's sync".
- Strip filler words. Be terse. "Meeting in 10min" not "You have a meeting starting in 10 minutes".
- For messages: "<name>: <gist>" — e.g. "Carl: new design ready"
- For alerts/system: describe the event — e.g. "Deploy failed: timeout" or "PR #421 merged"
- For emails: "<sender>: <subject gist>" — e.g. "Sarah: Q1 budget review"
- Never repeat the app name in the summary (it's already shown as a prefix).
- Never start with "You have" or "New notification".

Ranking criteria (most to least important):
1. Direct messages from people (Slack DM, iMessage, WhatsApp)
2. Urgent/time-sensitive (calendar reminders, alerts, incidents)
3. Actionable items (PR reviews, approvals, tasks assigned to you)
4. Group messages / channels
5. Informational (news, promotions, system updates)
6. Automated / marketing / spam

Output MUST be a valid JSON object:
{"notification_ranking": [{"uuid": "...", "summary": "...", "rank": 1}, ...]}`;

// ---------------------------------------------------------------------------
// NotificationService
// ---------------------------------------------------------------------------

export class NotificationService {
  private cache: PhoneNotification[] = [];
  private ranking: RankedNotification[] = [];
  private rankingInFlight = false;
  private readonly logger: Logger;

  constructor(parentLogger: Logger) {
    this.logger = parentLogger.child({ service: "NotificationService" });
    this.logger.info("NotificationService initialized");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add or replace a notification in the cache (matched by uuid), then prune
   * and trigger an async LLM re-ranking.
   */
  add(notification: PhoneNotification): void {
    const existingIndex = this.cache.findIndex((n) => n.uuid === notification.uuid);

    if (existingIndex >= 0) {
      this.cache[existingIndex] = notification;
      this.logger.debug({ uuid: notification.uuid }, "Replaced existing notification in cache");
    } else {
      this.cache.push(notification);
      this.logger.debug({ uuid: notification.uuid, cacheSize: this.cache.length }, "Added new notification to cache");
    }

    this.pruneCache();
    this.rankAsync();
  }

  /**
   * Remove a notification by its uuid (also accepts a notificationKey treated
   * as uuid for compatibility), then trigger an async LLM re-ranking.
   */
  dismiss(notificationId: string): void {
    const before = this.cache.length;
    this.cache = this.cache.filter((n) => n.uuid !== notificationId);
    const removed = before - this.cache.length;

    if (removed > 0) {
      // Also remove from the current ranking so display updates immediately.
      this.ranking = this.ranking.filter((r) => r.uuid !== notificationId);
      this.logger.debug({ notificationId }, "Dismissed notification from cache");
      this.rankAsync();
    } else {
      this.logger.debug({ notificationId }, "Dismiss called but notification not found in cache");
    }
  }

  /**
   * Returns the top-2 ranked notifications as display lines.
   *
   * Format: "[Gmail] OpenAI: Excel plugin down"
   *         "[Slack] Carl: new design ready"
   *
   * - If the cache is empty, returns "".
   * - If an LLM ranking is available, uses it; otherwise falls back to
   *   `fallbackRanking()` (sort by timestamp desc).
   */
  getDisplayText(): string {
    if (this.cache.length === 0) {
      return "";
    }

    const source = this.ranking.length > 0 ? this.ranking : this.fallbackRanking();

    // Build a uuid→notification lookup for fast access.
    const byUuid = new Map<string, PhoneNotification>(this.cache.map((n) => [n.uuid, n]));

    const lines: string[] = [];

    for (const ranked of source) {
      if (lines.length >= DISPLAY_TOP_N) break;

      const notification = byUuid.get(ranked.uuid);
      // Skip ranked entries whose notification has since been dismissed.
      if (!notification) continue;

      const appTag = this.formatAppTag(ranked.appName || notification.appName);
      const summary = ranked.summary;
      lines.push(`${appTag}${summary}`);
    }

    return lines.join("\n");
  }

  /**
   * Clean up resources. Currently a no-op (no intervals/streams to close),
   * but provided for lifecycle parity with other session-scoped managers.
   */
  dispose(): void {
    this.cache = [];
    this.ranking = [];
    this.rankingInFlight = false;
    this.logger.info("NotificationService disposed");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Format the app name tag: "[Gmail] ", "[Slack] ", etc.
   * Falls back to empty string if app name is unknown.
   */
  private formatAppTag(appName?: string): string {
    if (!appName) return "";

    // Shorten well-known verbose app names.
    const shortNames: Record<string, string> = {
      "Google Messages": "Msg",
      "Messages": "Msg",
      "Google Chat": "Chat",
      "Google Calendar": "Cal",
      "Google Maps": "Maps",
      "Google Drive": "Drive",
      "Google Meet": "Meet",
      "Microsoft Teams": "Teams",
      "Microsoft Outlook": "Outlook",
      "WhatsApp": "WA",
      "Facebook Messenger": "Msgr",
      "Instagram": "IG",
      "LinkedIn": "In",
    };

    const short = shortNames[appName] ?? appName;
    return `[${short}] `;
  }

  /**
   * Fires an async OpenAI ranking request.
   * Guards against concurrent in-flight requests — if one is already running,
   * this call is a no-op (the next `add`/`dismiss` will trigger a fresh one).
   */
  private rankAsync(): void {
    if (this.rankingInFlight) {
      this.logger.debug("Ranking already in flight — skipping");
      return;
    }

    if (this.cache.length === 0) {
      this.ranking = [];
      return;
    }

    this.rankingInFlight = true;

    // Fire-and-forget — intentionally not awaited.
    this.runRanking().catch((err) => {
      // runRanking() already handles its own errors; this is a safety net.
      this.logger.warn({ err }, "Unexpected error escaping runRanking()");
      this.rankingInFlight = false;
    });
  }

  /**
   * The actual async ranking logic, separated so `rankAsync` can remain sync.
   */
  private async runRanking(): Promise<void> {
    try {
      // Snapshot the cache at the moment the request is sent so the prompt
      // stays consistent even if new notifications arrive mid-flight.
      const snapshot = [...this.cache];

      const notificationList = snapshot
        .map((n) => {
          const preview = `${n.title}: ${n.content}`.slice(0, 200);
          return JSON.stringify({
            uuid: n.uuid,
            appName: n.appName ?? "Unknown",
            preview,
            timestamp: n.timestamp,
            viewCount: n.viewCount,
          });
        })
        .join("\n");

      const userMessage = `Please rank the following notifications:\n${notificationList}`;

      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const model = process.env.LLM_MODEL || "gpt-4o-mini";

      this.logger.debug({ model, count: snapshot.length }, "Sending notification ranking request to LLM");

      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: RANKING_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content;
      if (!raw) {
        this.logger.warn("LLM returned empty content for notification ranking");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        this.logger.warn({ raw, parseErr }, "Failed to parse LLM ranking response as JSON");
        return;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>)["notification_ranking"])
      ) {
        this.logger.warn({ parsed }, "LLM ranking response missing 'notification_ranking' array");
        return;
      }

      const rawRanking = (parsed as Record<string, unknown>)["notification_ranking"] as unknown[];

      // Build a uuid→appName lookup from the snapshot so we can tag each ranking entry.
      const appNameByUuid = new Map<string, string>(snapshot.map((n) => [n.uuid, n.appName ?? ""]));

      const newRanking: RankedNotification[] = [];

      for (const item of rawRanking) {
        if (typeof item !== "object" || item === null) continue;

        const entry = item as Record<string, unknown>;
        const uuid = typeof entry["uuid"] === "string" ? entry["uuid"] : undefined;
        const summary = typeof entry["summary"] === "string" ? entry["summary"] : undefined;
        const rank = typeof entry["rank"] === "number" ? entry["rank"] : undefined;

        if (!uuid || !summary || rank === undefined) continue;

        newRanking.push({
          uuid,
          summary: summary.slice(0, MAX_SUMMARY_CHARS),
          appName: appNameByUuid.get(uuid) ?? "",
          rank,
        });
      }

      // Sort ascending by rank (rank=1 is highest importance).
      newRanking.sort((a, b) => a.rank - b.rank);

      this.ranking = newRanking;

      this.logger.debug({ count: newRanking.length }, "Notification ranking updated from LLM");
    } catch (err) {
      this.logger.warn({ err }, "Failed to rank notifications via LLM — fallback will be used");
    } finally {
      this.rankingInFlight = false;
    }
  }

  /**
   * Deterministic fallback ranking when no LLM result is available yet.
   * Sorts by timestamp descending and truncates "title: content" to fit.
   */
  private fallbackRanking(): RankedNotification[] {
    return [...this.cache]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((n, idx) => ({
        uuid: n.uuid,
        summary: `${n.title}: ${n.content}`.slice(0, MAX_SUMMARY_CHARS),
        appName: n.appName ?? "",
        rank: idx + 1,
      }));
  }

  /**
   * Enforce cache size and view-count limits.
   *
   * - If cache exceeds MAX_CACHE_SIZE, remove the oldest entries first.
   * - Remove any entry whose viewCount exceeds MAX_VIEW_COUNT.
   */
  private pruneCache(): void {
    // Remove over-viewed notifications first.
    const beforeOverview = this.cache.length;
    this.cache = this.cache.filter((n) => n.viewCount <= MAX_VIEW_COUNT);
    const removedOverviewed = beforeOverview - this.cache.length;
    if (removedOverviewed > 0) {
      this.logger.debug({ removedOverviewed }, "Pruned over-viewed notifications from cache");
    }

    // Enforce max size by removing the oldest (lowest timestamp) entries.
    if (this.cache.length > MAX_CACHE_SIZE) {
      // Sort so oldest are at the front, then slice off the excess.
      this.cache.sort((a, b) => a.timestamp - b.timestamp);
      const excess = this.cache.length - MAX_CACHE_SIZE;
      this.cache.splice(0, excess);
      this.logger.debug({ excess }, "Pruned oldest notifications to enforce MAX_CACHE_SIZE");
    }

    // Keep the ranking in sync — drop entries for evicted notifications.
    if (this.ranking.length > 0) {
      const validUuids = new Set(this.cache.map((n) => n.uuid));
      this.ranking = this.ranking.filter((r) => validUuids.has(r.uuid));
    }
  }
}

export default NotificationService;
