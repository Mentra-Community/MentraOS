import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";

type Scope = "source" | "private";
interface Credentials { appId?: string; privateKey?: string; installationId?: string }
const grants = {
  source: { repositories: ["MentraOS"], permissions: { actions: "write", contents: "read", pull_requests: "read" } },
  private: { repositories: ["Mentra-Automated-Testing"], permissions: { actions: "read" } },
} as const;
const refreshBeforeMs = 60_000;

/** Installation tokens are scoped per repository and remain in memory only. */
export class TestRunGithubApp {
  private readonly credentials: Credentials;
  private readonly cache = new Map<Scope, { token: string; expiresAt: number }>();
  private readonly pending = new Map<Scope, Promise<string>>();
  constructor(private readonly options: { credentials?: Credentials; fetch?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number } = {}) {
    this.credentials = options.credentials ?? {
      appId: process.env.TEST_RUN_GITHUB_APP_ID,
      privateKey: process.env.TEST_RUN_GITHUB_APP_PRIVATE_KEY,
      installationId: process.env.TEST_RUN_GITHUB_INSTALLATION_ID,
    };
  }
  get configured() { return !!(this.credentials.appId && this.credentials.privateKey && this.credentials.installationId); }
  private now() { return (this.options.now ?? Date.now)(); }
  async token(scope: Scope): Promise<string> {
    const cached = this.cache.get(scope);
    if (cached && cached.expiresAt - this.now() > refreshBeforeMs) return cached.token;
    const pending = this.pending.get(scope);
    if (pending) return pending;
    const request = this.issue(scope).finally(() => this.pending.delete(scope));
    this.pending.set(scope, request);
    return request;
  }
  private async issue(scope: Scope): Promise<string> {
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
        body: JSON.stringify(grants[scope]),
      });
      if (response.status !== 201) throw new Error("Installation token request failed");
      const value = await response.json() as { token?: unknown; expires_at?: unknown };
      const expiresAt = typeof value.expires_at === "string" ? Date.parse(value.expires_at) : NaN;
      if (typeof value.token !== "string" || !value.token || !Number.isFinite(expiresAt) || expiresAt - this.now() <= refreshBeforeMs)
        throw new Error("Invalid installation token response");
      this.cache.set(scope, { token: value.token, expiresAt });
      return value.token;
    } catch {
      // Provider bodies, transport errors and key parsing errors can contain credentials.
      throw new Error("GitHub App installation authentication is unavailable");
    }
  }
}
