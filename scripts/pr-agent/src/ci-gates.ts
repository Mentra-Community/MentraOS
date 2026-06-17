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

export async function fetchCheckStatuses(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  requiredNames: string[],
): Promise<CiCheckStatus[]> {
  const { data } = await octokit.checks.listForRef({ owner, repo, ref, per_page: 100 });
  const runs = data.check_runs;

  return requiredNames.map((name) => {
    const run = runs.find((r) => r.name === name);
    return {
      name,
      status: run?.status ?? 'missing',
      conclusion: run?.conclusion ?? null,
      required: true,
    };
  });
}

export function isCiGreen(checks: CiCheckStatus[]): boolean {
  if (checks.length === 0) return true;
  return checks.every(
    (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'skipped'),
  );
}

export function isCiFailed(checks: CiCheckStatus[]): boolean {
  return checks.some(
    (c) =>
      c.status === 'completed' &&
      c.conclusion != null &&
      !['success', 'skipped', 'neutral'].includes(c.conclusion),
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
    const checks = await fetchCheckStatuses(octokit, owner, repo, ref, requiredNames);
    const allCompleted = checks.every(
      (c) => c.status === 'completed' || c.status === 'missing',
    );
    if (allCompleted) return checks;
    await sleep(30_000);
  }
  return fetchCheckStatuses(octokit, owner, repo, ref, requiredNames);
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
