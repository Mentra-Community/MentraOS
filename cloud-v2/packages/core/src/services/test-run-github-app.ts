import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import {appRepositorySchema, testingRepositorySchema, type AppRepository, type TestingRepository} from "../types/testing-source.types";

type Scope = "source" | "private" | "harness" | "reporter" | "checks" | "dispatch" | "runner";
interface Credentials { appId?: string; privateKey?: string; installationId?: string }
interface InstallationCredential { token: string; expiresAt: number }
const grants = {
  runner: { repositories: ["Mentra-Automated-Testing"], permissions: { organization_self_hosted_runners: "write" } },
  dispatch: { repositories: ["Mentra-Automated-Testing"], permissions: { actions: "write" } },
  reporter: { repositories: ["MentraOS"], permissions: { pull_requests: "write" } },
  checks: { repositories: ["MentraOS"], permissions: { checks: "write", pull_requests: "read", contents: "read" } },
  source: { repositories: ["MentraOS"], permissions: { actions: "write", contents: "read", pull_requests: "read" } },
  harness: { repositories: ["Mentra-Automated-Testing"], permissions: { contents: "read", pull_requests: "read" } },
  private: { repositories: ["Mentra-Automated-Testing"], permissions: { actions: "read" } },
} as const;
const refreshBeforeMs = 60_000;

/** Installation tokens remain in memory. Runner administration is an organization permission. */
export class TestRunGithubApp {
  private readonly credentials: Credentials;
  private readonly cache = new Map<string, InstallationCredential>();
  private readonly pending = new Map<string, Promise<InstallationCredential>>();
  constructor(private readonly options: { credentials?: Credentials; fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number } = {}) {
    this.credentials = options.credentials ?? {
      appId: process.env.TESTING_TEST_RUN_GITHUB_APP_ID ?? process.env.TEST_RUN_GITHUB_APP_ID,
      privateKey: process.env.TESTING_TEST_RUN_GITHUB_APP_PRIVATE_KEY ?? process.env.TEST_RUN_GITHUB_APP_PRIVATE_KEY,
      installationId: process.env.TESTING_TEST_RUN_GITHUB_APP_INSTALLATION_ID ?? process.env.TESTING_TEST_RUN_GITHUB_INSTALLATION_ID ?? process.env.TEST_RUN_GITHUB_INSTALLATION_ID,
    };
  }
  get configured() { return !!(this.credentials.appId && this.credentials.privateKey && this.credentials.installationId); }
  get applicationId() { return Number(this.credentials.appId) || null; }
  get installationId() { return Number(this.credentials.installationId) || null; }
  private now() { return (this.options.now ?? Date.now)(); }
  async token(scope: Scope, repository?: AppRepository | TestingRepository): Promise<string> {
    return (await this.installationCredential(scope, repository)).token;
  }
  async runnerCredential(repository?: TestingRepository): Promise<{credential: string; expiresAt: string}> {
    const value = await this.installationCredential("runner", repository);
    return {credential: value.token, expiresAt: new Date(value.expiresAt).toISOString()};
  }
  private async installationCredential(scope: Scope, repository?: AppRepository | TestingRepository): Promise<InstallationCredential> {
    const appScope = ["source", "reporter", "checks"].includes(scope);
    const target = (appScope ? appRepositorySchema : testingRepositorySchema).parse(repository ??
      (appScope ? "Mentra-Community/MentraOS" : "Mentra-Community/Mentra-Automated-Testing"));
    const key = `${scope}:${target}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > refreshBeforeMs) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.issue(scope, target, key).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
  private async issue(scope: Scope, repository: AppRepository | TestingRepository, key: string): Promise<InstallationCredential> {
    try {
      const { appId, privateKey, installationId } = this.credentials;
      if (!appId || !privateKey || !installationId || !/^[1-9]\d*$/.test(appId) || !/^[1-9]\d*$/.test(installationId))
        throw new Error("Missing GitHub App configuration");
      const now = Math.floor(this.now() / 1000);
      const jwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(appId)
        .setIssuedAt(now - 60).setExpirationTime(now + 9 * 60)
        .sign(createPrivateKey(privateKey.replace(/\\n/g, "\n")));
      const response = await (this.options.fetch ?? fetch)(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: JSON.stringify({...grants[scope], repositories: [repository.split("/")[1]]}),
      });
      if (response.status !== 201) throw new Error("Installation token request failed");
      const value = await response.json() as { token?: unknown; expires_at?: unknown };
      const expiresAt = typeof value.expires_at === "string" ? Date.parse(value.expires_at) : NaN;
      if (typeof value.token !== "string" || !value.token || !Number.isFinite(expiresAt) || expiresAt - this.now() <= refreshBeforeMs)
        throw new Error("Invalid installation token response");
      const credential = { token: value.token, expiresAt };
      this.cache.set(key, credential);
      return credential;
    } catch {
      // Provider bodies, transport errors and key parsing errors can contain credentials.
      throw new Error("GitHub App installation authentication is unavailable");
    }
  }
}
