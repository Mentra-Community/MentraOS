import { minimatch } from 'minimatch';
import type { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';

export type CiCheckStatus = {
  name: string;
  status: string;
  conclusion: string | null;
  required: boolean;
};

export function requiredWorkflowsForPaths(changedFiles: string[], repoRoot: string): string[] {
  const config = loadConfig(repoRoot);
  const required = new Set<string>();
  for (const gate of config.ciGates) {
    const matches = changedFiles.some((f) =>
      gate.paths.some((p) => minimatch(f, p, { dot: true })),
    );
    if (matches) {
      for (const w of gate.workflows) required.add(w);
    }
  }
  return [...required];
}

/** Match configured workflow `name:` values via Actions workflow runs for the commit. */
export async function fetchWorkflowStatuses(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  requiredWorkflowNames: string[],
): Promise<CiCheckStatus[]> {
  const { data } = await octokit.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: ref,
    per_page: 100,
  });

  return requiredWorkflowNames.map((workflowName) => {
    const runs = data.workflow_runs.filter((r) => r.name === workflowName);
    if (runs.length === 0) {
      return {
        name: workflowName,
        status: 'not_required',
        conclusion: null,
        required: false,
      };
    }
    const latest = [...runs].sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    )[0]!;
    return {
      name: workflowName,
      status: latest.status ?? 'missing',
      conclusion: latest.conclusion ?? null,
      required: true,
    };
  });
}

/** @deprecated Use fetchWorkflowStatuses */
export const fetchCheckStatuses = fetchWorkflowStatuses;

function requiredChecks(checks: CiCheckStatus[]): CiCheckStatus[] {
  return checks.filter((c) => c.required);
}

export function isCiGreen(checks: CiCheckStatus[]): boolean {
  const required = requiredChecks(checks);
  if (required.length === 0) return true;
  return required.every((c) => {
    if (['in_progress', 'queued', 'waiting', 'pending'].includes(c.status)) {
      return false;
    }
    if (c.status === 'completed') {
      return c.conclusion === 'success' || c.conclusion === 'skipped';
    }
    return false;
  });
}

export function isCiFailed(checks: CiCheckStatus[]): boolean {
  return requiredChecks(checks).some(
    (c) =>
      c.status === 'completed' &&
      c.conclusion != null &&
      !['success', 'skipped'].includes(c.conclusion),
  );
}

export async function pollCiUntilSettled(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  requiredNames: string[],
  maxWaitMin: number,
): Promise<CiCheckStatus[]> {
  const deadline = Date.now() + maxWaitMin * 60_000;
  while (Date.now() < deadline) {
    const checks = await fetchWorkflowStatuses(octokit, owner, repo, ref, requiredNames);
    const required = requiredChecks(checks);
    if (required.length === 0) return checks;
    const allSettled = required.every((c) => c.status === 'completed');
    if (allSettled) return checks;
    await sleep(30_000);
  }
  return fetchWorkflowStatuses(octokit, owner, repo, ref, requiredNames);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getPrHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  return data.head.sha;
}

export async function getPrHeadRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  return data.head.ref;
}

export async function getChangedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const files: string[] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    files.push(...data.map((f) => f.filename));
    page++;
  }
  return files;
}
