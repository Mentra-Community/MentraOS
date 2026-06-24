/**
 * DelegationManager — tracks in-flight giga-agent delegations.
 *
 * When a delegation runs past the grace window, the control plane returns a
 * taskId and finishes in the background. This registry holds the pending task
 * and fires `onComplete` when the result arrives — via either:
 *
 *   1. the webhook receiver calling complete() (primary), or
 *   2. a poll backstop against GET /tasks/:id (if a webhook is dropped).
 *
 * Whichever wins, the task is settled exactly once. The completion handler is
 * what re-enters QueryProcessor.deliverFollowUp() to speak/show the answer.
 */

import { agentBridge, type AgentTaskResult } from "./AgentBridge";

type CompletionHandler = (result: AgentTaskResult) => void | Promise<void>;

interface PendingTask {
  taskId: string;
  userId: string;
  onComplete: CompletionHandler;
  createdAt: number;
  settled: boolean;
  pollTimer?: ReturnType<typeof setTimeout>;
}

// How often the backstop polls, and how long before we give up on a task that
// never reports done (the control plane caps agent replies at 300s).
const POLL_INTERVAL_MS = 5_000;
const MAX_LIFETIME_MS = 6 * 60 * 1000;

export class DelegationManager {
  private pending = new Map<string, PendingTask>();

  /**
   * Register a delegation that went async. `onComplete` runs once, when the
   * task finishes (or times out). Starts the poll backstop immediately.
   */
  register(taskId: string, userId: string, onComplete: CompletionHandler): void {
    const task: PendingTask = {
      taskId,
      userId,
      onComplete,
      createdAt: Date.now(),
      settled: false,
    };
    this.pending.set(taskId, task);
    this.schedulePoll(task);
    console.log(`🤝 [Delegation] registered pending task ${taskId} for ${userId}`);
  }

  /** Called by the webhook receiver when the control plane reports a result. */
  async complete(taskId: string, result: AgentTaskResult): Promise<void> {
    const task = this.pending.get(taskId);
    if (!task || task.settled) return; // unknown or already settled (idempotent)
    this.settle(task, result);
  }

  /** True if we are still waiting on this task (used to validate webhooks). */
  isPending(taskId: string): boolean {
    return this.pending.has(taskId);
  }

  private settle(task: PendingTask, result: AgentTaskResult): void {
    task.settled = true;
    if (task.pollTimer) clearTimeout(task.pollTimer);
    this.pending.delete(task.taskId);
    console.log(`🤝 [Delegation] settled task ${task.taskId} (${result.status})`);
    Promise.resolve(task.onComplete(result)).catch((err) =>
      console.error(`🤝 [Delegation] onComplete for ${task.taskId} threw:`, err),
    );
  }

  private scheduleNext(task: PendingTask): void {
    task.pollTimer = setTimeout(() => this.poll(task), POLL_INTERVAL_MS);
  }

  private schedulePoll(task: PendingTask): void {
    this.scheduleNext(task);
  }

  private async poll(task: PendingTask): Promise<void> {
    if (task.settled) return;

    if (Date.now() - task.createdAt > MAX_LIFETIME_MS) {
      this.settle(task, {
        taskId: task.taskId,
        userId: task.userId,
        status: "failed",
        error: "delegation timed out",
      });
      return;
    }

    const result = await agentBridge.getTask(task.userId, task.taskId);
    if (task.settled) return; // a webhook may have landed mid-poll
    if (result && result.status !== "working") {
      this.settle(task, result);
      return;
    }
    this.scheduleNext(task);
  }
}

/** Singleton — import this everywhere. */
export const delegations = new DelegationManager();
