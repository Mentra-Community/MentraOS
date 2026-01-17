import { StoredBugReport } from '../types/config';
import { logger } from './logger';

/**
 * Simple in-memory store for bug reports with private data (emails).
 * In production, this should be replaced with a database.
 */
class BugReportStore {
  private reports: Map<string, StoredBugReport> = new Map();

  store(threadId: string, report: StoredBugReport): void {
    this.reports.set(threadId, report);
    logger.info({ threadId, hasEmail: !!report.email }, 'Stored bug report data');
  }

  get(threadId: string): StoredBugReport | undefined {
    return this.reports.get(threadId);
  }

  getEmail(threadId: string): string | null {
    const report = this.reports.get(threadId);
    return report?.email || null;
  }

  hasEmail(threadId: string): boolean {
    const report = this.reports.get(threadId);
    return !!report?.email;
  }

  getAllReportsWithEmail(): StoredBugReport[] {
    return Array.from(this.reports.values()).filter(r => !!r.email);
  }

  getAllReportsWithoutEmail(): StoredBugReport[] {
    return Array.from(this.reports.values()).filter(r => !r.email);
  }
}

export const bugReportStore = new BugReportStore();
