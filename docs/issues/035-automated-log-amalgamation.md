# Automated Log Amalgamation for Bug Reports

**Status:** Planning
**Priority:** High
**Estimated Effort:** 2-3 weeks

## Overview

When a user presses "Give Feedback" in MentraOS and submits a **bug report**, automatically capture and amalgamate the last 10 minutes of logs from all system components (phone, cloud, glasses), store them privately, and create/update Linear tickets with secure log access links.

## Goals

1. **Reduce debugging time**: Engineers should understand a bug from logs alone, without messaging the user
2. **Automatic deduplication**: Multiple reports of same bug consolidate into one Linear ticket (via LLM)
3. **Privacy-preserving**: Logs contain PII, only accessible to authenticated Mentra admins
4. **Agent-ready**: Structure data so coding agents can consume it for automated fixes

## Current State

| Component              | What Exists                                               | Gap                                               |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Mobile feedback UI     | Full form with system/glasses info                        | No log capture, no state snapshot                 |
| Cloud feedback service | MongoDB storage, email/Slack notifications                | No log aggregation, links don't point to Linear   |
| Cloud logging          | Pino → BetterStack with filtering                         | No per-user query capability                      |
| Glasses (asg_client)   | FileReportProvider writes to `/sdcard/mentra_crash_logs/` | Only ERROR/CRITICAL, no feedback-triggered upload |

## Architecture

```
User presses "Give Feedback" (bug report)
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ MOBILE APP                                                  │
│ 1. Snapshot all Zustand stores (glasses, core, debug, etc.) │
│ 2. POST /api/client/feedback (feedback + state snapshot)    │
│ 3. Receive incidentId from cloud                            │
│ 4. POST /api/incidents/:incidentId/logs (phone logs)        │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────┐
│ CLOUD (sync response)  │
│ 1. Generate incidentId │
│ 2. Store feedback +    │
│    state to R2         │
│ 3. Return incidentId   │
└────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│ CLOUD (background job)                                     │
│ 1. Query BetterStack for user's cloud logs (last 10min)    │
│ 2. Append cloud logs to incident (direct function call)    │
│ 3. Request app telemetry via WebSocket                     │
│ 4. LLM: Generate bug summary                               │
│ 5. LLM: Check for similar existing Linear issues           │
│ 6. Create new Linear ticket OR add logs to existing one    │
│ 7. Send Slack/email with Linear ticket link                │
└────────────────────────────────────────────────────────────┘
         │
         ▼ (async, logs arrive from various sources)
┌────────────────────────────────────────────────────────────┐
│ UNIFIED LOGS ENDPOINT: POST /api/incidents/:id/logs        │
│ - Phone logs (auth: coreToken)                             │
│ - App telemetry (auth: apiKey)                             │
│ - Glasses logs (auth: coreToken) [FUTURE]                  │
│ - All append to same R2 incident file                      │
└────────────────────────────────────────────────────────────┘
```

**Key design:** All log sources POST to a single unified endpoint. The initial feedback request creates the incident with state; logs flow through the unified endpoint.

## Log File Structure (R2)

Single JSON file per incident, appended as data arrives:

```
incidents/{incidentId}/logs.json
```

```json
{
  "incidentId": "01HXYZ...",
  "createdAt": "2024-02-21T...",
  "feedback": { /* user's bug report */ },

  "phoneState": {
    "glasses": { /* full GlassesStore snapshot */ },
    "core": { /* full CoreStore snapshot */ },
    "debug": { /* full DebugStore snapshot */ },
    "applets": { /* running apps, etc. */ },
    "settings": { /* relevant settings */ }
  },

  "phoneLogs": [
    { "timestamp": 1708..., "level": "info", "message": "...", "source": "BLE" },
    { "timestamp": 1708..., "level": "error", "message": "...", "source": "WebSocket" }
  ],

  "cloudLogs": [
    { "timestamp": "2024-02-21T...", "level": "info", "message": "...", "service": "websocket-glasses" }
  ],

  "glassesLogs": [
    { "timestamp": "2024-02-21T...", "level": "error", "message": "...", "category": "BLE" }
  ]
}
```

## Implementation Plan

### Phase 1: Mobile Log Ring Buffer + State Snapshot

**Files to create/modify:**

- `mobile/src/services/LogRingBuffer.ts` (new)
- `mobile/src/app/settings/feedback.tsx`
- `mobile/src/services/RestComms.ts`

**Log Ring Buffer:**

```typescript
// mobile/src/services/LogRingBuffer.ts
interface LogEntry {
  timestamp: number
  level: "debug" | "info" | "warn" | "error"
  message: string
  source?: string // 'BLE', 'WebSocket', 'Navigation', 'Network', etc.
  metadata?: Record<string, unknown>
}

class LogRingBuffer {
  private logs: LogEntry[] = []
  private maxAgeMs = 10 * 60 * 1000 // 10 minutes
  private maxEntries = 10000

  append(entry: Omit<LogEntry, "timestamp">) {
    this.logs.push({...entry, timestamp: Date.now()})
    this.prune()
  }

  getRecentLogs(): LogEntry[] {
    this.prune()
    return [...this.logs]
  }

  private prune() {
    const cutoff = Date.now() - this.maxAgeMs
    this.logs = this.logs.filter((l) => l.timestamp > cutoff)
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries)
    }
  }
}

export const logBuffer = new LogRingBuffer()

// Intercept console methods
const originalConsole = {...console}
;["log", "info", "warn", "error"].forEach((level) => {
  console[level] = (...args) => {
    originalConsole[level](...args)
    logBuffer.append({
      level: level === "log" ? "info" : level,
      message: args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
      source: "console",
    })
  }
})
```

**State Snapshot (in feedback.tsx):**

```typescript
// Collect all relevant state for bug reports
const collectStateSnapshot = () => ({
  glasses: useGlassesStore.getState(),
  core: useCoreStore.getState(),
  debug: useDebugStore.getState(),
  applets: {
    apps: useAppletStatusStore.getState().apps,
    runningApps: useAppletStatusStore.getState().apps.filter((a) => a.running),
  },
  settings: {
    offlineMode: useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key),
    defaultWearable: useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key),
    // ... other relevant settings
  },
})
```

**What to log (sources):**

- `console.*` calls (already intercepted)
- BLE state changes: connection, disconnection, errors
- WebSocket events: connect, disconnect, message errors
- Navigation: screen changes (from NavigationHistoryContext)
- Network: request URL + status code (no bodies)
- Native module events from `core` module

**Feedback submission flow (two steps):**

```typescript
// In feedback.tsx submit handler
const submitBugReport = async () => {
  // Step 1: Create incident with feedback + state
  const response = await restComms.submitFeedback({
    type: 'bug',
    description,
    expectedBehavior,
    actualBehavior,
    phoneState: collectStateSnapshot(),
    // Note: logs NOT included here
  });

  if (!response.incidentId) {
    throw new Error('Failed to create incident');
  }

  // Step 2: Upload logs to unified endpoint
  const logs = logBuffer.getRecentLogs();
  await restComms.uploadIncidentLogs(response.incidentId, logs);

  // Step 3: Request glasses logs via BLE (Phase 2 - Future)
  // await bleService.requestLogUpload(response.incidentId, coreToken);
};

// Add to RestComms.ts:
async uploadIncidentLogs(incidentId: string, logs: LogEntry[]): Promise<void> {
  await this.post(`/api/incidents/${incidentId}/logs`, {
    source: 'phone',
    logs,
  });
}
```

**Effort:** 4-5 days

---

### Phase 2: Cloud Feedback API Enhancement

**Files to modify:**

- `cloud/packages/cloud/src/types/feedback.types.ts`
- `cloud/packages/cloud/src/services/client/feedback.service.ts`
- `cloud/packages/cloud/src/api/client/feedback.api.ts`

**New types:**

```typescript
// feedback.types.ts additions
interface PhoneStateSnapshot {
  glasses: Record<string, unknown>
  core: Record<string, unknown>
  debug: Record<string, unknown>
  applets: Record<string, unknown>
  settings: Record<string, unknown>
}

interface EnhancedFeedbackData extends FeedbackData {
  phoneState?: PhoneStateSnapshot // State snapshot included here
  // Note: phoneLogs are NOT included - they go to unified logs endpoint
}

interface FeedbackResponse {
  success: boolean
  incidentId?: string // Only for bug reports
}
```

**New MongoDB model (`cloud/packages/cloud/src/models/incident.model.ts`):**

```typescript
import mongoose, {Schema, Document} from "mongoose"

export interface IIncident extends Document {
  incidentId: string
  userId: string
  status: "processing" | "complete" | "partial" | "failed"
  linearIssueId?: string
  linearIssueUrl?: string
  errorMessage?: string
  createdAt: Date
  updatedAt: Date
}

const IncidentSchema = new Schema<IIncident>(
  {
    incidentId: {type: String, required: true, unique: true, index: true},
    userId: {type: String, required: true, index: true},
    status: {
      type: String,
      enum: ["processing", "complete", "partial", "failed"],
      default: "processing",
    },
    linearIssueId: {type: String},
    linearIssueUrl: {type: String},
    errorMessage: {type: String},
  },
  {timestamps: true},
)

export const Incident = mongoose.model<IIncident>("Incident", IncidentSchema)
```

**Payload size estimate:** ~50 KB typical (just feedback + state, no logs).

**Sync response flow:**

```typescript
// feedback.service.ts
export async function submitFeedback(userId: string, feedback: EnhancedFeedbackData): Promise<FeedbackResponse> {
  const isBugReport = feedback.type === "bug"

  // Save to MongoDB (existing behavior)
  await Feedback.create({userId, feedback: JSON.stringify(feedback)})

  if (!isBugReport) {
    // Feature requests: just email/slack, no incident
    await emailService.sendFeedback(userId, formatFeedbackAsHtml(feedback, userId), admins)
    await slackService.notifyUserFeedback(userId, feedback)
    return {success: true}
  }

  // Bug reports: create incident
  const incidentId = uuidv4() // import { v4 as uuidv4 } from 'uuid';

  // Store feedback + state to R2 (logs come via unified endpoint)
  await r2Storage.storeIncidentLogs(incidentId, {
    incidentId,
    createdAt: new Date().toISOString(),
    feedback,
    phoneState: feedback.phoneState,
    phoneLogs: [], // Populated via POST /api/incidents/:id/logs
    cloudLogs: [], // Populated by background job via same endpoint
    glassesLogs: [], // Populated async via same endpoint
    appTelemetryLogs: [], // Populated via same endpoint
  })

  // Save incident record
  await Incident.create({
    incidentId,
    userId,
    status: "processing",
    createdAt: new Date(),
  })

  // Queue background job for cloud logs + Linear
  queueIncidentProcessing(incidentId, userId)

  return {success: true, incidentId}
}
```

**Mobile then POSTs logs separately:**

After receiving `incidentId`, mobile immediately calls:

```
POST /api/incidents/:incidentId/logs
Authorization: Bearer <coreToken>
Body: { "logs": [...phoneLogs...] }
```

**Effort:** 2-3 days

---

### Phase 3: Background Job for Cloud Logs + Linear

**Files to create:**

- `cloud/packages/cloud/src/services/incidents/incident-processor.service.ts`
- `cloud/packages/cloud/src/services/logging/betterstack-query.service.ts`
- `cloud/packages/cloud/src/services/integrations/linear.service.ts`

**Background job approach:** Fire-and-forget async (no Redis needed at current volume of ~20/day):

```typescript
// In feedback.service.ts - don't await, just fire
function queueIncidentProcessing(incidentId: string, userId: string) {
  // Fire and forget - don't block the API response
  processIncident(incidentId, userId).catch((err) => {
    logger.error({incidentId, err}, "Background incident processing failed")
  })
}
```

**Background job flow (with error handling for partial incidents):**

```typescript
// incident-processor.service.ts
import { appendLogsToIncident } from './incident-logs.service';

export async function processIncident(incidentId: string, userId: string) {
  let cloudLogs: LogEntry[] = [];
  let logUrl: string | null = null;
  let summary: BugSummary | null = null;
  let linearIssueId: string | null = null;
  let linearIssueUrl: string | null = null;
  const errors: string[] = [];

  // 1. Query BetterStack for cloud logs (non-fatal if fails)
  try {
    cloudLogs = await queryBetterStackLogs(userId, 10 * 60 * 1000);
  } catch (err) {
    logger.warn({ incidentId, err }, 'Failed to query BetterStack logs');
    errors.push('BetterStack query failed');
  }

  // 2. Append cloud logs directly (same function the endpoint uses)
  try {
    await appendLogsToIncident(incidentId, 'cloudLogs', cloudLogs);
    // Console URL for humans, agents use shell script to fetch via API
    logUrl = `https://console.mentra.glass/admin/incidents/${incidentId}`;
  } catch (err) {
    logger.error({ incidentId, err }, 'Failed to append cloud logs');
    errors.push('Cloud logs storage failed');
  }

  // 3. LLM: Generate bug summary (non-fatal if fails)
  try {
    const existingLogs = await r2Storage.getIncidentLogs(incidentId);
    summary = await generateBugSummary(existingLogs);
  } catch (err) {
    logger.warn({ incidentId, err }, 'Failed to generate bug summary');
    errors.push('LLM summary failed');
    // Fallback summary
    summary = {
      title: 'Bug report (auto-summary failed)',
      description: 'See logs for details',
      affectedComponents: [],
      severity: 'medium',
    };
  }

  // 4. Create or update Linear ticket
  let isNewIssue = true;
  try {
    const similarIssue = await findSimilarLinearIssue(summary);

    if (similarIssue) {
      isNewIssue = false;
      await linear.createComment({
        issueId: similarIssue.id,
        body: `**New occurrence reported**\n\n${logUrl ? `[View logs](${logUrl})` : '(logs unavailable)'}\n\nSummary: ${summary.description}`,
      });
      linearIssueId = similarIssue.id;
      linearIssueUrl = similarIssue.url;
    } else {
      const issue = await linear.createIssue({
        teamId: TEAM_ID,
        title: summary.title,
        description: `${summary.description}\n\n${logUrl ? `[View logs](${logUrl})` : '(logs unavailable)'}`,
      });
      linearIssueId = issue.id;
      linearIssueUrl = issue.url;
    }
  } catch (err) {
    logger.error({ incidentId, err }, 'Failed to create Linear ticket');
    errors.push('Linear API failed');
  }

  // 5. Update incident record
  const status = errors.length === 0 ? 'complete' : (linearIssueUrl ? 'partial' : 'failed');
  await Incident.updateOne(
    { incidentId },
    {
      status,
      linearIssueId,
      linearIssueUrl,
      errorMessage: errors.length > 0 ? errors.join('; ') : undefined,
    }
  );

  // 6. Send notifications with Linear link
  // Note: These methods need to be added to the existing services
  await slackService.notifyBugReport({
    linearUrl: linearIssueUrl,
    summary: summary.title,
    isNewIssue,
  });

  await emailService.sendBugReportNotification({
    linearUrl: linearIssueUrl,
    summary: summary.title,
  });
}

// --- New methods to add to existing services ---

// Add to slack.service.ts:
async notifyBugReport(opts: { linearUrl?: string; summary: string; isNewIssue: boolean }): Promise<boolean> {
  const prefix = opts.isNewIssue ? '[BUG] New:' : '[BUG] +1 occurrence:';
  const message = `${prefix} ${opts.summary}${opts.linearUrl ? `\n<${opts.linearUrl}|View in Linear>` : ''}`;
  return this.sendMessage('#bugs', message);
}

// Add to resend.service.ts (email):
async sendBugReportNotification(opts: { linearUrl?: string; summary: string }): Promise<void> {
  const subject = `[BUG] ${opts.summary}`;
  const body = `A new bug report has been filed.\n\nSummary: ${opts.summary}\n\n${opts.linearUrl ? `View: ${opts.linearUrl}` : ''}`;
  await this.sendEmail({ to: ADMIN_EMAILS, subject, body });
}
```

**BetterStack Query:**

BetterStack uses a SQL-based Query API with HTTP Basic Auth. Credentials are created via **AI SRE → MCP and API** in the BetterStack dashboard.

```typescript
// betterstack-query.service.ts

// Credentials from BetterStack dashboard (AI SRE → MCP and API)
const BETTERSTACK_USERNAME = process.env.BETTERSTACK_USERNAME
const BETTERSTACK_PASSWORD = process.env.BETTERSTACK_PASSWORD
const BETTERSTACK_SOURCE = process.env.BETTERSTACK_SOURCE // e.g., "t123456_cloud_logs"

export async function queryBetterStackLogs(
  userId: string, // Currently email, but will be unique ID when WeChat login added
  windowMs: number,
): Promise<LogEntry[]> {
  const now = Math.floor(Date.now() / 1000)
  const since = now - Math.floor(windowMs / 1000)

  // BetterStack uses SQL queries with JSONExtract for filtering JSON fields
  const query = `
    SELECT dt, raw
    FROM remote(${BETTERSTACK_SOURCE})
    WHERE dt BETWEEN toDateTime64(${since}, 0, 'UTC') AND toDateTime64(${now}, 0, 'UTC')
      AND JSONExtract(raw, 'userId', 'Nullable(String)') = '${userId}'
    ORDER BY dt DESC
    LIMIT 1000
    FORMAT JSONEachRow
  `

  const response = await fetch("https://eu-nbg-2-connect.betterstackdata.com?output_format_pretty_row_numbers=0", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "Authorization": "Basic " + Buffer.from(`${BETTERSTACK_USERNAME}:${BETTERSTACK_PASSWORD}`).toString("base64"),
    },
    body: query,
  })

  const text = await response.text()
  // JSONEachRow format: one JSON object per line
  const lines = text.trim().split("\n").filter(Boolean)
  return lines.map((line) => {
    const {dt, raw} = JSON.parse(line)
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    return {
      timestamp: dt,
      level: parsed.level || "info",
      message: parsed.msg || parsed.message || JSON.stringify(parsed),
      source: parsed.service || "cloud",
    }
  })
}
```

**Note:** Cloud logs already include `userId` in Pino child logger context via auth middleware (see `client-auth-middleware.ts:72`). BetterStack queries will use `userId` field. Currently `userId` equals email, but will support WeChat login in future where userId != email.

**Effort:** 4-5 days

---

### Phase 4: R2 Private Storage

**Files to modify:**

- `cloud/packages/cloud/src/services/storage/r2-storage.service.ts`

**Add incident methods:**

```typescript
// r2-storage.service.ts additions
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Type for incident logs stored in R2
interface IncidentLogs {
  incidentId: string;
  createdAt: string;
  feedback: Record<string, unknown>;
  phoneState: Record<string, unknown>;
  phoneLogs: Array<{ timestamp: number; level: string; message: string; source?: string }>;
  cloudLogs: Array<{ timestamp: string; level: string; message: string; service?: string }>;
  glassesLogs: Array<{ timestamp: string; level: string; message: string; category?: string }>;
  appTelemetryLogs: Array<{ timestamp: number; level: string; message: string; source?: string }>;
}

private incidentsBucket = process.env.R2_INCIDENTS_BUCKET || "mentra-incidents";

async storeIncidentLogs(incidentId: string, logs: object): Promise<void> {
  const key = `incidents/${incidentId}/logs.json`;
  await this.s3Client.send(new PutObjectCommand({
    Bucket: this.incidentsBucket,
    Key: key,
    Body: JSON.stringify(logs, null, 2),
    ContentType: 'application/json',
  }));
}

async getIncidentLogs(incidentId: string): Promise<IncidentLogs> {
  const key = `incidents/${incidentId}/logs.json`;
  const response = await this.s3Client.send(new GetObjectCommand({
    Bucket: this.incidentsBucket,
    Key: key,
  }));
  const body = await response.Body?.transformToString();
  return JSON.parse(body || '{}');
}

// Note: getSignedUrl kept for potential internal use but NOT used for Linear tickets
// Linear tickets link to console.mentra.glass/admin/incidents/{id} instead
async getSignedUrl(incidentId: string, expiresInDays = 7): Promise<string> {
  const key = `incidents/${incidentId}/logs.json`;
  const command = new GetObjectCommand({
    Bucket: this.incidentsBucket,
    Key: key,
  });
  return getSignedUrl(this.s3Client, command, {
    expiresIn: expiresInDays * 24 * 60 * 60
  });
}

async appendGlassesLogs(incidentId: string, glassesLogs: LogEntry[]): Promise<void> {
  const existing = await this.getIncidentLogs(incidentId);
  existing.glassesLogs = glassesLogs;
  await this.storeIncidentLogs(incidentId, existing);
}
```

**R2 Setup:**

- Create `mentra-incidents` bucket (private, no public access)
- Set lifecycle policy: delete after 30 days (or keep forever, R2 is cheap)

**Effort:** 1 day

---

### Phase 5: Linear Integration with LLM Deduplication

**Files to create:**

- `cloud/packages/cloud/src/services/integrations/linear.service.ts`

**Note:** Use existing `LLMProvider` from `@mentra/utils` for LLM calls. It returns LangChain models.

```typescript
// linear.service.ts
import {LinearClient} from "@linear/sdk"
import {LLMProvider} from "@mentra/utils"

const linear = new LinearClient({apiKey: process.env.LINEAR_API_KEY})
const TEAM_ID = process.env.LINEAR_TEAM_ID

// Types
interface BugSummary {
  title: string
  description: string
  affectedComponents: string[]
  severity: "low" | "medium" | "high" | "critical"
}

// Helper to get date 30 days ago for Linear queries
function thirtyDaysAgo(): Date {
  const date = new Date()
  date.setDate(date.getDate() - 30)
  return date
}

// Parse LLM response into structured BugSummary
function parseBugSummary(response: string): BugSummary {
  // Simple parsing - could be improved with structured output
  const lines = response.split("\n")
  return {
    title:
      lines[0]
        ?.replace(/^(title:|1\.|#)/i, "")
        .trim()
        .slice(0, 80) || "Bug report",
    description: lines.slice(1, 4).join(" ").trim() || "See logs for details",
    affectedComponents: [], // Could parse from response
    severity: "medium",
  }
}

export async function generateBugSummary(incident: IncidentLogs): Promise<BugSummary> {
  const llm = LLMProvider.getLLM({temperature: 0.3, maxTokens: 500})

  const prompt = `Analyze this bug report and logs. Generate:
1. A concise title (max 80 chars)
2. A brief description of the likely issue
3. Affected components (e.g., "BLE", "Audio", "WebSocket")
4. Severity (low/medium/high/critical)

Bug report:
Expected: ${incident.feedback.expectedBehavior}
Actual: ${incident.feedback.actualBehavior}
Severity rating: ${incident.feedback.severityRating}/5

Phone state snapshot:
${JSON.stringify(incident.phoneState, null, 2)}

Recent phone logs (errors/warnings):
${incident.phoneLogs
  .filter((l) => ["error", "warn"].includes(l.level))
  .slice(-50)
  .map((l) => l.message)
  .join("\n")}

Cloud logs (errors/warnings):
${incident.cloudLogs
  .filter((l) => ["error", "warn"].includes(l.level))
  .slice(-50)
  .map((l) => l.message)
  .join("\n")}`

  const response = await llm.invoke(prompt)
  return parseBugSummary(response.content as string)
}

export async function findSimilarLinearIssue(summary: BugSummary): Promise<Issue | null> {
  // Get recent open bug issues
  const recentIssues = await linear.issues({
    filter: {
      labels: {name: {eq: "bug"}},
      state: {type: {in: ["backlog", "todo", "inProgress"]}},
      createdAt: {gte: thirtyDaysAgo()},
    },
    first: 50,
  })

  if (recentIssues.nodes.length === 0) return null

  const prompt = `Given this new bug:
Title: ${summary.title}
Description: ${summary.description}
Components: ${summary.affectedComponents.join(", ")}

Does it describe the SAME underlying issue as any of these existing tickets?
Only match if it's clearly the same root cause, not just similar symptoms.

Existing tickets:
${recentIssues.nodes.map((i, idx) => `${idx + 1}. [${i.identifier}] ${i.title}`).join("\n")}

Reply with ONLY the ticket identifier (e.g., "MEN-123") if there's a match, or "NONE" if this is a new issue.`

  const llm = LLMProvider.getLLM({temperature: 0.1, maxTokens: 50})
  const response = await llm.invoke(prompt)
  const match = (response.content as string).trim()

  if (match === "NONE") return null

  return recentIssues.nodes.find((i) => i.identifier === match) || null
}
```

**Effort:** 3-4 days

---

### Phase 6: Admin-Only Log Viewer API (Backend)

**Problem:** We can't put signed R2 URLs directly in Linear tickets because Linear syncs to public GitHub issues. Signed URLs would expose PII-containing logs publicly.

**Solution:** Proxy log access through Mentra API. Linear tickets link to the console UI: `https://console.mentra.glass/admin/incidents/{incidentId}`. Access requires:

1. Humans: View in console UI after Supabase login
2. Agents: Use `./scripts/fetch-incident-logs.sh {incidentId}` (calls API with `X-Agent-Key`)

**How console auth works (standard pattern):**

1. User logs in via Supabase (Google OAuth, email/password, etc.)
2. Console stores Supabase JWT and sets `Authorization: Bearer <jwt>` header on all axios requests
3. Backend `authenticateConsole` middleware verifies JWT and extracts user email
4. Route handlers check `isMentraAdmin(email)` to restrict admin-only endpoints

**Files to create/modify:**

- `cloud/packages/cloud/src/api/hono/console/incidents.api.ts` (new)
- `cloud/packages/cloud/src/api/hono/console/index.ts` (mount incidents routes at `/admin/incidents`)

```typescript
// incidents.api.ts
import {Hono} from "hono"
import {isMentraAdmin} from "../../../services/core/admin.utils"
import {authenticateConsole} from "../middleware/console.middleware"
import {r2Storage} from "../../../services/storage/r2-storage.service"
import {Incident} from "../../../models/incident.model"

const incidentRoutes = new Hono()

// Apply console auth middleware (or allow agent key)
incidentRoutes.use("*", async (c, next) => {
  // Check for agent API key first
  const agentKey = c.req.header("X-Agent-Key")
  const expectedAgentKey = process.env.MENTRA_AGENT_API_KEY

  if (agentKey && expectedAgentKey && agentKey === expectedAgentKey) {
    // Agent authenticated - skip Supabase auth
    c.set("isAgent", true)
    return next()
  }

  // Fall back to normal console auth (Supabase JWT)
  return authenticateConsole(c, next)
})

// GET /api/console/admin/incidents/:incidentId/logs
incidentRoutes.get("/:incidentId/logs", async (c) => {
  const isAgent = c.get("isAgent")

  if (!isAgent) {
    const {email} = c.get("console")
    if (!isMentraAdmin(email)) {
      return c.json({error: "Admin access required"}, 403)
    }
  }

  const incidentId = c.req.param("incidentId")

  try {
    const logs = await r2Storage.getIncidentLogs(incidentId)
    return c.json(logs)
  } catch (err) {
    return c.json({error: "Incident not found"}, 404)
  }
})

// GET /api/console/admin/incidents - list recent incidents
incidentRoutes.get("/", async (c) => {
  const isAgent = c.get("isAgent")

  if (!isAgent) {
    const {email} = c.get("console")
    if (!isMentraAdmin(email)) {
      return c.json({error: "Admin access required"}, 403)
    }
  }

  const incidents = await Incident.find()
    .sort({createdAt: -1})
    .limit(100)
    .select("incidentId userId status linearIssueUrl errorMessage createdAt")

  return c.json(incidents)
})

export {incidentRoutes}
```

**Agent API Key:**

- Simple shared secret stored in `MENTRA_AGENT_API_KEY` env var
- Agents send via `X-Agent-Key` header
- No complex auth needed - just a way to authenticate non-human access

**Effort:** 1 day

---

### Phase 6b: Developer Console Incidents Pages (Frontend)

**Files to create/modify:**

- `cloud/websites/console/src/App.tsx` (add routes)
- `cloud/websites/console/src/pages/IncidentsList.tsx` (new - list all incidents)
- `cloud/websites/console/src/pages/IncidentDetail.tsx` (new - view single incident)
- `cloud/websites/console/src/components/DashboardLayout.tsx` (add sidebar link)
- `cloud/websites/console/src/services/api.service.ts` (add incident API methods)

**Simple routing structure:**

- `/admin/incidents` - List page (table of all incidents)
- `/admin/incidents/{id}` - Detail page (log viewer for one incident)
- Clicking a row in the list navigates to the detail page
- Same detail page whether you come from Linear link or from list

AdminPanel (`/admin`) stays as-is. We add a "Bug Reports" link in the sidebar that goes to `/admin/incidents`.

**DashboardLayout.tsx sidebar addition (near existing Admin Panel link):**

```typescript
{isAdmin && (
  <Link
    to="/admin/incidents"
    className={cn(
      "flex items-center gap-2 px-3 py-2 rounded-md text-sm",
      isActivePath("/admin/incidents")
        ? "bg-accent text-accent-foreground"
        : "hover:bg-accent/50"
    )}
  >
    <Bug className="h-4 w-4" />
    Bug Reports
  </Link>
)}
```

**App.tsx routes:**

```typescript
// Add these routes
// Note: requireAdmin prop exists but frontend check is disabled -
// admin access is enforced by backend returning 403 for non-admins
<Route
  path="/admin/incidents"
  element={
    <ProtectedRoute>
      <IncidentsList />
    </ProtectedRoute>
  }
/>
<Route
  path="/admin/incidents/:incidentId"
  element={
    <ProtectedRoute>
      <IncidentDetail />
    </ProtectedRoute>
  }
/>
```

**IncidentsList.tsx:**

```typescript
// cloud/websites/console/src/pages/IncidentsList.tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/services/api.service';

interface Incident {
  incidentId: string;
  userId: string;
  status: 'processing' | 'complete' | 'partial' | 'failed';
  linearIssueUrl?: string;
  errorMessage?: string;
  createdAt: string;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    processing: 'bg-yellow-100 text-yellow-800',
    complete: 'bg-green-100 text-green-800',
    partial: 'bg-orange-100 text-orange-800',
    failed: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`px-2 py-1 rounded text-xs ${colors[status] || 'bg-gray-100'}`}>
      {status}
    </span>
  );
}

export function IncidentsList() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.admin.getIncidents().then(data => {
      setIncidents(data);
      setLoading(false);
    });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Bug Reports</h1>

      <table className="w-full">
        <thead>
          <tr>
            <th>ID</th>
            <th>User</th>
            <th>Status</th>
            <th>Linear</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map(incident => (
            <tr
              key={incident.incidentId}
              className="cursor-pointer hover:bg-gray-100"
              onClick={() => navigate(`/admin/incidents/${incident.incidentId}`)}
            >
              <td>{incident.incidentId.slice(0, 8)}...</td>
              <td>{incident.userId}</td>
              <td><StatusBadge status={incident.status} /></td>
              <td>
                {incident.linearIssueUrl && (
                  <a
                    href={incident.linearIssueUrl}
                    onClick={e => e.stopPropagation()}
                    target="_blank"
                  >
                    View
                  </a>
                )}
              </td>
              <td>{new Date(incident.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**IncidentDetail.tsx:**

```typescript
// cloud/websites/console/src/pages/IncidentDetail.tsx
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '@/services/api.service';

interface IncidentLogs {
  incidentId: string;
  createdAt: string;
  feedback: Record<string, unknown>;
  phoneState: Record<string, unknown>;
  phoneLogs: LogEntry[];
  cloudLogs: LogEntry[];
  glassesLogs: LogEntry[];
  appTelemetryLogs: LogEntry[];
}

interface LogEntry {
  timestamp: number | string;
  level: string;
  message: string;
  source?: string;
}

export function IncidentDetail() {
  const { incidentId } = useParams<{ incidentId: string }>();
  const [logs, setLogs] = useState<IncidentLogs | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'phone' | 'cloud' | 'glasses' | 'state' | 'feedback'>('phone');

  useEffect(() => {
    if (incidentId) {
      api.admin.getIncidentLogs(incidentId).then(data => {
        setLogs(data);
        setLoading(false);
      });
    }
  }, [incidentId]);

  if (loading) return <div>Loading...</div>;
  if (!logs) return <div>Incident not found</div>;

  return (
    <div className="p-6">
      <Link to="/admin/incidents" className="text-blue-500 mb-4 block">
        ← Back to list
      </Link>

      <h1 className="text-2xl font-bold mb-4">
        Incident {incidentId?.slice(0, 8)}...
      </h1>
      <p className="text-gray-500 mb-4">
        {new Date(logs.createdAt).toLocaleString()}
      </p>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        <button
          className={activeTab === 'phone' ? 'font-bold' : ''}
          onClick={() => setActiveTab('phone')}
        >
          Phone ({logs.phoneLogs?.length || 0})
        </button>
        <button
          className={activeTab === 'cloud' ? 'font-bold' : ''}
          onClick={() => setActiveTab('cloud')}
        >
          Cloud ({logs.cloudLogs?.length || 0})
        </button>
        <button
          className={activeTab === 'glasses' ? 'font-bold' : ''}
          onClick={() => setActiveTab('glasses')}
        >
          Glasses ({logs.glassesLogs?.length || 0})
        </button>
        <button
          className={activeTab === 'state' ? 'font-bold' : ''}
          onClick={() => setActiveTab('state')}
        >
          State
        </button>
        <button
          className={activeTab === 'feedback' ? 'font-bold' : ''}
          onClick={() => setActiveTab('feedback')}
        >
          Feedback
        </button>
      </div>

      {/* Content */}
      <div className="bg-gray-50 p-4 rounded overflow-auto max-h-[70vh]">
        {activeTab === 'phone' && <LogTable logs={logs.phoneLogs} />}
        {activeTab === 'cloud' && <LogTable logs={logs.cloudLogs} />}
        {activeTab === 'glasses' && <LogTable logs={logs.glassesLogs} />}
        {activeTab === 'state' && (
          <pre className="text-sm">{JSON.stringify(logs.phoneState, null, 2)}</pre>
        )}
        {activeTab === 'feedback' && (
          <pre className="text-sm">{JSON.stringify(logs.feedback, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

function LogTable({ logs }: { logs: LogEntry[] }) {
  if (!logs?.length) return <p>No logs</p>;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th className="text-left">Time</th>
          <th className="text-left">Level</th>
          <th className="text-left">Source</th>
          <th className="text-left">Message</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((log, i) => (
          <tr key={i} className={log.level === 'error' ? 'bg-red-50' : ''}>
            <td className="whitespace-nowrap">
              {typeof log.timestamp === 'number'
                ? new Date(log.timestamp).toLocaleTimeString()
                : log.timestamp}
            </td>
            <td>{log.level}</td>
            <td>{log.source || '-'}</td>
            <td className="font-mono">{log.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

**api.service.ts additions:**

```typescript
// Add to api.service.ts admin section
admin: {
  // ... existing methods ...

  getIncidents: async (): Promise<Incident[]> => {
    const response = await axios.get('/api/console/admin/incidents');
    return response.data;
  },

  getIncidentLogs: async (incidentId: string): Promise<IncidentLogs> => {
    const response = await axios.get(`/api/console/admin/incidents/${incidentId}/logs`);
    return response.data;
  },
}
```

**Effort:** 2 days

---

### Phase 6c: Agent Access via Shell Script

**Files to create:**

- `scripts/fetch-incident-logs.sh`
- Update root `AGENTS.md`

Linear tickets will link to `console.mentra.glass/admin/incidents/{id}` for human-readable UI. Agents use a shell script to fetch the raw JSON.

**Shell script:**

```bash
#!/bin/bash
# scripts/fetch-incident-logs.sh
# Fetch incident logs for debugging bug reports
# Usage: ./scripts/fetch-incident-logs.sh <incidentId>

set -e

INCIDENT_ID=$1

if [ -z "$INCIDENT_ID" ]; then
  echo "Usage: ./scripts/fetch-incident-logs.sh <incidentId>"
  echo "Example: ./scripts/fetch-incident-logs.sh 01HXYZ..."
  exit 1
fi

if [ -z "$MENTRA_AGENT_API_KEY" ]; then
  echo "Error: MENTRA_AGENT_API_KEY environment variable not set"
  exit 1
fi

curl -s -H "X-Agent-Key: $MENTRA_AGENT_API_KEY" \
  "https://cloud.mentra.glass/api/console/admin/incidents/$INCIDENT_ID/logs" | jq .
```

**Add to root AGENTS.md:**

```markdown
## Bug Report Logs

When working on bug reports linked to `console.mentra.glass/admin/incidents/{id}`:

1. Extract the incident ID from the URL
2. Fetch logs: `./scripts/fetch-incident-logs.sh {incidentId}`
3. Requires `MENTRA_AGENT_API_KEY` in your environment

The logs JSON contains:

- `phoneLogs` - Last 10 min of mobile app logs
- `cloudLogs` - Last 10 min of cloud service logs
- `glassesLogs` - Last 10 min of glasses logs (if available)
- `appTelemetryLogs` - Logs from third-party apps (if telemetry enabled)
- `phoneState` - Snapshot of app state at time of report
- `feedback` - User's bug report description
```

**Effort:** 0.5 days

---

### Phase 7: Unified Incident Logs Endpoint

**Goal:** Single endpoint for external callers (phone, glasses, miniapps) to POST logs to an incident. Cloud background job calls the shared function directly.

**Endpoint:**

```
POST /api/incidents/:incidentId/logs
```

**Auth (middleware checks in order, accepts first match):**

- Phone/Glasses: `Authorization: Bearer <coreToken>`
- Miniapps: `X-App-Api-Key: <apiKey>` + `X-App-Package: <packageName>`

**Request body:**

```json
{
  "source": "phone",  // "phone" | "glasses" | omit for apps (derived from packageName)
  "logs": [
    { "timestamp": 1708..., "level": "error", "message": "...", "source": "BLE" }
  ]
}
```

**Files to create:**

- `cloud/packages/cloud/src/services/incidents/incident-logs.service.ts` (shared function)
- `cloud/packages/cloud/src/api/hono/incidents/logs.api.ts` (endpoint)

**Shared function (used by endpoint and background job):**

```typescript
// incident-logs.service.ts
import {r2Storage} from "../storage/r2-storage.service"
import {Incident} from "../../models/incident.model"
import {linear} from "../integrations/linear.service"
import {logger} from "@mentra/utils"

type LogCategory = "phoneLogs" | "glassesLogs" | "cloudLogs" | "appTelemetryLogs"

export async function appendLogsToIncident(
  incidentId: string,
  category: LogCategory,
  logs: LogEntry[],
  source?: string,
): Promise<void> {
  const incident = await Incident.findOne({incidentId})
  if (!incident) {
    throw new Error("Incident not found")
  }

  // Tag logs with source if provided
  const taggedLogs = source
    ? logs.map((log) => ({...log, source: log.source ? `${source}:${log.source}` : source}))
    : logs

  // Append to R2
  const existing = await r2Storage.getIncidentLogs(incidentId)
  existing[category] = [...(existing[category] || []), ...taggedLogs]
  await r2Storage.storeIncidentLogs(incidentId, existing)

  // If glasses logs arrived and we have a Linear ticket, add a comment
  if (category === "glassesLogs" && incident.linearIssueId) {
    await linear.createComment({
      issueId: incident.linearIssueId,
      body: `Glasses logs received (${taggedLogs.length} entries)`,
    })
  }

  logger.info({incidentId, category, count: taggedLogs.length}, "Logs appended to incident")
}
```

**Endpoint (calls shared function):**

```typescript
// logs.api.ts
import {Hono} from "hono"
import {appendLogsToIncident} from "../../../services/incidents/incident-logs.service"
import {validateCoreToken} from "../../../services/auth/core-token.service"
import {validateAppApiKey} from "../../../services/apps/app-validation.service"
import {logger} from "@mentra/utils"

const incidentLogsRoutes = new Hono()

// POST /api/incidents/:incidentId/logs
incidentLogsRoutes.post("/:incidentId/logs", async (c) => {
  const incidentId = c.req.param("incidentId")
  let source: string
  let logCategory: "phoneLogs" | "glassesLogs" | "appTelemetryLogs"

  const body = await c.req.json<{source?: string; logs: LogEntry[]}>()

  // Check coreToken auth (phone or glasses)
  const authHeader = c.req.header("Authorization")
  const coreToken = authHeader?.replace("Bearer ", "")

  if (coreToken) {
    const isValid = await validateCoreToken(coreToken)
    if (!isValid) {
      return c.json({error: "Invalid token"}, 401)
    }
    source = body.source || "phone"
    logCategory = source === "glasses" ? "glassesLogs" : "phoneLogs"
  } else {
    // Check app auth (apiKey)
    const apiKey = c.req.header("X-App-Api-Key")
    const packageName = c.req.header("X-App-Package")

    if (!apiKey || !packageName) {
      return c.json({error: "Missing auth"}, 401)
    }

    const isValid = await validateAppApiKey(packageName, apiKey)
    if (!isValid) {
      return c.json({error: "Invalid app credentials"}, 401)
    }
    source = `app:${packageName}`
    logCategory = "appTelemetryLogs"
  }

  // Validate payload
  if (!body.logs || !Array.isArray(body.logs)) {
    return c.json({error: "Invalid payload"}, 400)
  }

  // Append logs using shared function
  try {
    await appendLogsToIncident(incidentId, logCategory, body.logs, source)
    return c.json({success: true})
  } catch (err) {
    if (err.message === "Incident not found") {
      return c.json({error: "Incident not found"}, 404)
    }
    logger.error({incidentId, source, err}, "Failed to append logs")
    return c.json({error: "Storage error"}, 500)
  }
})

export {incidentLogsRoutes}
```

**Mount in api/index.ts:**

```typescript
import {incidentLogsRoutes} from "./hono/incidents/logs.api"
app.route("/api/incidents", incidentLogsRoutes)
```

**Effort:** 1-2 days

---

### Phase 8: Miniapp Telemetry Collection (Phase 2)

**Goal:** Automatically capture SDK internal logs from third-party apps. When a user files a bug report, cloud requests logs from running apps via WebSocket, apps POST back to the unified incident endpoint.

**Design:**

1. SDK automatically buffers its own internal logs (no developer effort)
2. Devs opt-in with `enableTelemetry: true` in AppServer config
3. Cloud sends WebSocket message: `REQUEST_TELEMETRY { incidentId, windowMs }`
4. App receives via WebSocket, POSTs buffered logs to `POST /api/incidents/:incidentId/logs` with auth headers

```
User submits bug report
    → Cloud creates incident, processes phone/cloud logs
    → Cloud sends via WebSocket to each connected app: REQUEST_TELEMETRY { incidentId, windowMs }
    → App receives message in AppSession.handleMessage()
    → App POSTs logs to /api/incidents/:incidentId/logs with X-App-Api-Key + X-App-Package headers
    → Cloud aggregates into incident (fire-and-forget, no waiting)
```

**Key implementation notes:**
- Uses existing authenticated app WebSocket connections (no new endpoints needed)
- Apps derive cloud URL from WebSocket URL via `getHttpsServerUrl()` (converts `wss://host/app-ws` to `https://host`)
- Authentication uses existing X-App-Api-Key + X-App-Package headers
- Fire-and-forget pattern - cloud doesn't wait for app responses

---

#### 8.1 SDK Changes

**Files to modify:**

- `cloud/packages/sdk/src/types/app-server.types.ts`
- `cloud/packages/sdk/src/app/server/index.ts`
- `cloud/packages/sdk/src/types/message-types.ts`

**AppServerConfig addition:**

```typescript
// app-server.types.ts
export interface AppServerConfig {
  // ... existing fields ...

  /**
   * Enable telemetry for incident debugging.
   * When enabled, SDK internal logs are buffered and sent to
   * Mentra Cloud when a user files a bug report.
   * Default: false (opt-in for privacy)
   */
  enableTelemetry?: boolean
}
```

**New message type:**

```typescript
// message-types.ts
export enum CloudToAppMessageType {
  // ... existing types ...
  REQUEST_TELEMETRY = "request_telemetry",
}

export interface RequestTelemetryMessage {
  type: CloudToAppMessageType.REQUEST_TELEMETRY
  userId: string
  incidentId: string
}
```

**AppServer telemetry buffer + handler:**

```typescript
// In AppServer class (app/server/index.ts)

interface TelemetryLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
}

// Add to class properties:
private telemetryEnabled: boolean;
private telemetryBuffer: Map<string, TelemetryLogEntry[]> = new Map(); // userId -> logs
private readonly TELEMETRY_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
private readonly TELEMETRY_MAX_ENTRIES = 500;

// In constructor:
this.telemetryEnabled = config.enableTelemetry || false;

if (this.telemetryEnabled) {
  this.interceptSdkLogs();
  logger.info('Telemetry enabled - SDK logs will be buffered');
}

// Intercept SDK logger to capture logs automatically
private interceptSdkLogs(): void {
  // Wrap the SDK's logger to capture all internal logs
  // This captures logs from the SDK itself, not app code
  const originalLogger = logger;
  const self = this;

  ['debug', 'info', 'warn', 'error'].forEach(level => {
    const original = originalLogger[level].bind(originalLogger);
    originalLogger[level] = (obj: any, msg?: string) => {
      // Call original
      original(obj, msg);

      // Buffer for telemetry (extract userId from context if available)
      const userId = obj?.userId || self.currentSessionUserId;
      if (userId && self.telemetryEnabled) {
        self.bufferLog(userId, {
          level: level as any,
          message: msg || (typeof obj === 'string' ? obj : JSON.stringify(obj)),
          source: 'sdk',
        });
      }
    };
  });
}

private bufferLog(userId: string, entry: Omit<TelemetryLogEntry, 'timestamp'>): void {
  const logs = this.telemetryBuffer.get(userId) || [];
  logs.push({ ...entry, timestamp: Date.now() });

  // Prune old logs
  const cutoff = Date.now() - this.TELEMETRY_MAX_AGE_MS;
  const pruned = logs.filter(l => l.timestamp > cutoff);

  // Trim to max size
  if (pruned.length > this.TELEMETRY_MAX_ENTRIES) {
    pruned.splice(0, pruned.length - this.TELEMETRY_MAX_ENTRIES);
  }

  this.telemetryBuffer.set(userId, pruned);
}

// Handle telemetry request from cloud
private async handleTelemetryRequest(message: RequestTelemetryMessage): Promise<void> {
  if (!this.telemetryEnabled) return;

  const { userId, incidentId } = message;
  const logs = this.telemetryBuffer.get(userId) || [];

  if (logs.length === 0) return;

  // Prune before sending
  const cutoff = Date.now() - this.TELEMETRY_MAX_AGE_MS;
  const recentLogs = logs.filter(l => l.timestamp > cutoff);

  // POST to incident logs endpoint
  try {
    await fetch(
      `${this.cloudHost}/api/incidents/${incidentId}/logs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Api-Key': this.config.apiKey,
          'X-App-Package': this.config.packageName,
        },
        body: JSON.stringify({ logs: recentLogs }),
      }
    );
    logger.debug({ incidentId, count: recentLogs.length }, 'Telemetry sent');
  } catch (err) {
    logger.warn({ incidentId, err }, 'Failed to send telemetry');
  }
}

// In WebSocket message handler, add case:
case CloudToAppMessageType.REQUEST_TELEMETRY:
  this.handleTelemetryRequest(message as RequestTelemetryMessage);
  break;
```

**Effort:** 2 days

---

#### 8.2 Cloud Changes

**Files to modify:**

- `cloud/packages/cloud/src/services/incidents/incident-processor.service.ts`
- `cloud/packages/cloud/src/types/websocket-messages.ts`

**Add to incident processor (after creating incident, before Linear):**

```typescript
// In processIncident function, add after cloud logs query:

// 5. Request telemetry from running apps for this user
try {
  await requestAppTelemetry(userId, incidentId)
  // Give apps a moment to POST their logs
  await new Promise((resolve) => setTimeout(resolve, 2000))
} catch (err) {
  logger.warn({incidentId, err}, "Failed to request app telemetry")
  errors.push("App telemetry request failed")
}

// Helper function
async function requestAppTelemetry(userId: string, incidentId: string): Promise<void> {
  // Get all active app connections for this user
  const appConnections = appConnectionManager.getConnectionsForUser(userId)

  // Send REQUEST_TELEMETRY to each
  for (const conn of appConnections) {
    conn.send(
      JSON.stringify({
        type: "request_telemetry",
        userId,
        incidentId,
      }),
    )
  }

  logger.info({userId, incidentId, appCount: appConnections.length}, "Requested telemetry from apps")
}
```

**Effort:** 1 day

---

#### 8.3 Update R2 Log Structure & Console UI

**Update IncidentLogs interface:**

```typescript
interface IncidentLogs {
  incidentId: string
  createdAt: string
  feedback: Record<string, unknown>
  phoneState: Record<string, unknown>
  phoneLogs: LogEntry[]
  cloudLogs: LogEntry[]
  glassesLogs: LogEntry[]
  appTelemetryLogs: LogEntry[] // NEW: Logs from third-party apps
}
```

**Update IncidentDetail.tsx - add Apps tab:**

```typescript
// Add to tabs
<button
  className={activeTab === 'apps' ? 'font-bold' : ''}
  onClick={() => setActiveTab('apps')}
>
  Apps ({logs.appTelemetryLogs?.length || 0})
</button>

// Add to content
{activeTab === 'apps' && <LogTable logs={logs.appTelemetryLogs} />}
```

**Effort:** 0.5 days

---

#### Phase 8 Summary

| Component                                     | Effort   |
| --------------------------------------------- | -------- |
| SDK telemetry buffer + auto-capture + handler | 2 days   |
| Cloud REQUEST_TELEMETRY message               | 1 day    |
| R2 types + Console UI                         | 0.5 days |

**Total Phase 8 Effort:** 3.5 days

---

### Phase 9: Glasses Log Upload [FUTURE]

**Files to modify:**

- `asg_client/app/src/main/java/com/mentra/asg_client/...`
- BLE protocol definitions

**Approach:**

1. Define new BLE message: `REQUEST_LOG_UPLOAD { incidentId, coreToken }`
2. Glasses receives command, stores pending upload
3. When WiFi connects, POST to `POST /api/incidents/:incidentId/logs` (same unified endpoint)
4. Auth via `Authorization: Bearer <coreToken>`

**This phase deferred** - phone + cloud logs provide enough value initially.

**Effort (when implemented):** 3-5 days

---

## Environment Variables (New)

```bash
# BetterStack SQL Query API (create credentials via AI SRE → MCP and API in dashboard)
BETTERSTACK_USERNAME=xxx
BETTERSTACK_PASSWORD=xxx
BETTERSTACK_SOURCE=t373499_augmentos_logs  # From BetterStack dashboard

# R2 incidents bucket (separate from public assets)
R2_INCIDENTS_BUCKET=mentra-incidents

# Linear integration
LINEAR_API_KEY=xxx
LINEAR_TEAM_ID=xxx

# Agent API access (shared secret for coding agents to access logs)
MENTRA_AGENT_API_KEY=xxx  # Generate a random string, share with agents
```

## Security Model

| Data              | Storage                          | Access                                                 |
| ----------------- | -------------------------------- | ------------------------------------------------------ |
| Raw logs          | R2 `mentra-incidents` bucket     | Via Mentra API proxy only (no public URLs)             |
| Incident metadata | MongoDB `incidents` collection   | Admin API only                                         |
| Linear tickets    | Linear (synced to public GitHub) | Contains console URL only (requires auth to view logs) |
| User ID           | NOT in Linear ticket body        | Only in private incident record                        |

**Key principles:**

- Logs never exposed publicly — accessed only via authenticated Mentra API
- Linear tickets link to `console.mentra.glass/admin/incidents/{id}` (human-friendly UI)
- Humans: View logs in console UI after Supabase login
- Agents: Use `./scripts/fetch-incident-logs.sh {id}` with `MENTRA_AGENT_API_KEY` env var
- User ID stored in private MongoDB, not in public Linear body
- R2 bucket has no public access; logs fetched server-side and proxied

## Notification Flow

When a bug is processed:

1. **Slack**: `"[BUG] Notifications not syncing on G1 - MEN-456 (new issue)" + Linear link`
2. **Email**: Same content to ADMIN_EMAILS

When duplicate is detected:

1. **Slack**: `"[BUG] +1 occurrence: Notifications not syncing - MEN-456" + Linear link`
2. **Email**: Same content

## MVP Scope

Everything except glasses log upload:

- [x] Design doc (this document)
- [x] Mobile: Log ring buffer + console interception (Phase 1)
- [x] Mobile: State snapshot collection (Phase 1)
- [x] Mobile: Enhanced feedback submission (Phase 1)
- [x] Cloud: Enhanced feedback API with incidentId (Phase 2)
- [x] Cloud: Unified incident logs endpoint (Phase 2b)
- [x] Cloud: Background job infrastructure (Phase 3)
- [x] Cloud: BetterStack query integration (Phase 3)
- [x] Cloud: R2 incident storage (Phase 4)
- [x] Cloud: Linear ticket creation with LLM deduplication (Phase 5)
- [x] Cloud: Slack/email notifications with Linear links (Phase 5)
- [x] Cloud: Admin API for incidents (Phase 6)
- [x] Console: Incidents list page (Phase 6b)
- [x] Console: Incident detail page (Phase 6b)
- [x] Scripts: `fetch-incident-logs.sh` for agents (Phase 6c)
- [x] Docs: Update AGENTS.md with bug report log instructions (Phase 6c)
- [x] SDK: Miniapp telemetry buffer + auto-capture (Phase 8)
- [x] Cloud: REQUEST_TELEMETRY via WebSocket, apps POST back to /api/incidents/:id/logs (Phase 8)
- [x] Notifications: Single notification per bug report (after Linear ticket creation, not duplicate)

## Future Scope

- [ ] Glasses log upload via BLE command (Phase 9)
  - Define BLE message: `REQUEST_LOG_UPLOAD { incidentId, coreToken }`
  - asg_client queues upload, POSTs when WiFi available
  - Uses same unified `/api/incidents/:id/logs` endpoint
- [ ] Incident timeline visualization (enhanced UI)

## Open Questions (Resolved)

1. ~~BetterStack query API~~ → Will use, token provided
2. ~~Log file structure~~ → Single JSON file per incident, sections for each source
3. ~~Glasses auth~~ → coreToken + incidentId
4. ~~LLM timing~~ → Background job, user gets immediate response
5. ~~What to log~~ → Console + BLE + WebSocket + Navigation + Network + full state snapshot
6. ~~User email in Linear~~ → NOT included in ticket body, only in private incident record
