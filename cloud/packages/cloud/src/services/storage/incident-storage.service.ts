// services/storage/incident-storage.service.ts
// Private R2 storage for incident logs - no public access

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { logger as rootLogger } from "../logging/pino-logger";
import type { AttachmentMetadata } from "../../types/feedback.types";

const logger = rootLogger.child({ service: "incident-storage" });

/**
 * Log entry structure for all log sources.
 */
export interface LogEntry {
  timestamp: number | string;
  level: string;
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Complete incident logs structure stored in R2.
 */
export interface IncidentLogs {
  incidentId: string;
  createdAt: string;
  feedback: Record<string, unknown>;
  phoneState: Record<string, unknown>;
  phoneLogs: LogEntry[];
  cloudLogs: LogEntry[];
  glassesLogs: LogEntry[];
  /** BES chip logs uploaded with source "glasses_firmware" */
  glassesFirmwareLogs: LogEntry[];
  /** App telemetry logs organized by package name */
  appTelemetryLogs: Record<string, LogEntry[]>;
  attachments?: AttachmentMetadata[];
}

/**
 * Service for storing and retrieving incident logs from R2.
 * Uses a private bucket (no public access) - logs are accessed via API proxy only.
 */
class IncidentStorageService {
  private s3Client: S3Client | null = null;
  private bucketName: string;
  private initialized = false;

  // Per-incident locks to prevent concurrent read-modify-write race conditions
  private locks: Map<string, Promise<void>> = new Map();

  constructor() {
    this.bucketName = process.env.R2_INCIDENTS_BUCKET || "mentra-incidents";
  }

  /**
   * Execute a function with a per-incident lock.
   * Operations on the same incident are queued and executed sequentially.
   */
  private async withLock<T>(incidentId: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any previous operation on this incident to complete
    const previous = this.locks.get(incidentId) ?? Promise.resolve();

    // Create a new promise that will resolve when our operation completes
    let resolve: () => void;
    const current = new Promise<void>((r) => {
      resolve = r;
    });
    this.locks.set(incidentId, current);

    // Wait for previous operation
    await previous;

    try {
      return await fn();
    } finally {
      resolve!();
      // Clean up if this is still the latest operation (prevents memory leak)
      if (this.locks.get(incidentId) === current) {
        this.locks.delete(incidentId);
      }
    }
  }

  /**
   * Lazy initialization of S3 client.
   * This allows the service to be imported even if R2 credentials are not yet configured.
   */
  private ensureInitialized(): void {
    if (this.initialized) {
      return;
    }

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      logger.warn(
        {
          hasAccountId: !!accountId,
          hasAccessKeyId: !!accessKeyId,
          hasSecretAccessKey: !!secretAccessKey,
        },
        "R2 credentials not configured - incident storage disabled",
      );
      this.initialized = true;
      return;
    }

    this.s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    this.initialized = true;
    logger.info({ bucketName: this.bucketName }, "IncidentStorageService initialized");
  }

  /**
   * Store incident logs to R2.
   */
  async storeIncidentLogs(incidentId: string, logs: IncidentLogs): Promise<void> {
    this.ensureInitialized();

    if (!this.s3Client) {
      logger.warn({ incidentId }, "R2 not configured - skipping incident storage");
      return;
    }

    const objectKey = `incidents/${incidentId}.json`;

    try {
      const putCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
        Body: JSON.stringify(logs, null, 2),
        ContentType: "application/json",
        Metadata: {
          incidentid: incidentId,
          createdat: logs.createdAt,
        },
      });

      await this.s3Client.send(putCommand);

      logger.info(
        {
          incidentId,
          objectKey,
          phoneLogsCount: logs.phoneLogs?.length || 0,
          cloudLogsCount: logs.cloudLogs?.length || 0,
        },
        "Incident logs stored to R2",
      );
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          incidentId,
        },
        "Failed to store incident logs to R2",
      );
      throw new Error("Failed to store incident logs");
    }
  }

  /**
   * Retrieve incident logs from R2.
   */
  async getIncidentLogs(incidentId: string): Promise<IncidentLogs> {
    this.ensureInitialized();

    if (!this.s3Client) {
      throw new Error("R2 not configured");
    }

    const objectKey = `incidents/${incidentId}.json`;

    try {
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });

      const response = await this.s3Client.send(getCommand);

      if (!response.Body) {
        throw new Error("Empty response body");
      }

      const bodyContents = await response.Body.transformToString();
      const logs = JSON.parse(bodyContents) as IncidentLogs;
      // Backward compatibility: old documents may lack glassesFirmwareLogs
      logs.glassesFirmwareLogs = logs.glassesFirmwareLogs ?? [];

      logger.info({ incidentId }, "Retrieved incident logs from R2");

      return logs;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorName = err instanceof Error ? err.name : "Unknown";

      if (errorName === "NoSuchKey") {
        throw new Error("Incident not found");
      }

      logger.error(
        {
          error: errorMessage,
          incidentId,
        },
        "Failed to retrieve incident logs from R2",
      );
      throw new Error("Failed to retrieve incident logs");
    }
  }

  /**
   * Append logs to a specific category in an existing incident.
   * Uses per-incident locking to prevent race conditions.
   */
  async appendLogs(
    incidentId: string,
    category: "phoneLogs" | "cloudLogs" | "glassesLogs" | "glassesFirmwareLogs",
    logs: LogEntry[],
    source?: string,
  ): Promise<void> {
    return this.withLock(incidentId, async () => {
      // Fetch existing logs
      const existing = await this.getIncidentLogs(incidentId);

      // Tag logs with source if provided
      const taggedLogs = source
        ? logs.map((log) => ({
            ...log,
            source: log.source ? `${source}:${log.source}` : source,
          }))
        : logs;

      // Append to the appropriate category
      existing[category] = [...(existing[category] || []), ...taggedLogs];

      if (category === "glassesFirmwareLogs") {
        logger.info(
          { incidentId, count: taggedLogs.length },
          "[incident-storage] Appended glasses_firmware (BES) logs to incident",
        );
      }

      // Store back to R2
      await this.storeIncidentLogs(incidentId, existing);

      logger.info(
        {
          incidentId,
          category,
          count: taggedLogs.length,
        },
        "Appended logs to incident",
      );
    });
  }

  /**
   * Append app telemetry logs for a specific app.
   * Logs are organized by package name.
   * Uses per-incident locking to prevent race conditions.
   */
  async appendAppTelemetry(incidentId: string, packageName: string, logs: LogEntry[]): Promise<void> {
    return this.withLock(incidentId, async () => {
      // Fetch existing logs
      const existing = await this.getIncidentLogs(incidentId);

      // Initialize appTelemetryLogs if needed
      if (!existing.appTelemetryLogs) {
        existing.appTelemetryLogs = {};
      }

      // Append to the app's log array
      existing.appTelemetryLogs[packageName] = [...(existing.appTelemetryLogs[packageName] || []), ...logs];

      // Store back to R2
      await this.storeIncidentLogs(incidentId, existing);

      logger.info(
        {
          incidentId,
          packageName,
          count: logs.length,
        },
        "Appended app telemetry to incident",
      );
    });
  }

  /**
   * Store an attachment (screenshot) for an incident.
   * Returns metadata that should be appended to the incident logs.
   */
  async storeAttachment(
    incidentId: string,
    filename: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<AttachmentMetadata> {
    this.ensureInitialized();

    if (!this.s3Client) {
      throw new Error("R2 not configured");
    }

    // Sanitize filename and create unique storage key
    const sanitizedFilename = filename
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/--+/g, "-")
      .toLowerCase();
    const timestamp = Date.now();
    const storedAs = `incidents/${incidentId}/attachments/${timestamp}-${sanitizedFilename}`;

    try {
      const putCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: storedAs,
        Body: buffer,
        ContentType: mimeType,
        Metadata: {
          incidentid: incidentId,
          originalfilename: filename,
          uploadedat: new Date().toISOString(),
        },
      });

      await this.s3Client.send(putCommand);

      const metadata: AttachmentMetadata = {
        filename,
        storedAs,
        mimeType,
        size: buffer.length,
        uploadedAt: new Date().toISOString(),
      };

      logger.info(
        {
          incidentId,
          storedAs,
          size: buffer.length,
          mimeType,
        },
        "Attachment stored to R2",
      );

      return metadata;
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          incidentId,
          filename,
        },
        "Failed to store attachment to R2",
      );
      throw new Error("Failed to store attachment");
    }
  }

  /**
   * Retrieve an attachment from R2.
   */
  async getAttachment(incidentId: string, storedFilename: string): Promise<{ buffer: Buffer; mimeType: string }> {
    this.ensureInitialized();

    if (!this.s3Client) {
      throw new Error("R2 not configured");
    }

    // Construct the object key
    const objectKey = `incidents/${incidentId}/attachments/${storedFilename}`;

    try {
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: objectKey,
      });

      const response = await this.s3Client.send(getCommand);

      if (!response.Body) {
        throw new Error("Empty response body");
      }

      const byteArray = await response.Body.transformToByteArray();
      const buffer = Buffer.from(byteArray);

      return {
        buffer,
        mimeType: response.ContentType || "application/octet-stream",
      };
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : "Unknown";

      if (errorName === "NoSuchKey") {
        throw new Error("Attachment not found");
      }

      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          incidentId,
          storedFilename,
        },
        "Failed to retrieve attachment from R2",
      );
      throw new Error("Failed to retrieve attachment");
    }
  }

  /**
   * Add attachment metadata to an incident's logs.
   * Uses per-incident locking to prevent race conditions.
   */
  async appendAttachment(incidentId: string, attachment: AttachmentMetadata): Promise<void> {
    return this.withLock(incidentId, async () => {
      const existing = await this.getIncidentLogs(incidentId);

      existing.attachments = [...(existing.attachments || []), attachment];

      await this.storeIncidentLogs(incidentId, existing);

      logger.info(
        {
          incidentId,
          filename: attachment.filename,
          totalAttachments: existing.attachments.length,
        },
        "Appended attachment metadata to incident",
      );
    });
  }
}

// Export singleton instance
export const incidentStorage = new IncidentStorageService();
