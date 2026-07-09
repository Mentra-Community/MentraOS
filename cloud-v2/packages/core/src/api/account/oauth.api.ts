/**
 * @fileoverview Core-hosted OAuth for the account module (issue 019 spec.md §OAuth).
 * Mounted at /api/account/oauth.
 *
 * Flow: the app opens the system browser at /:provider/start with a PKCE
 * challenge; core redirects into Supabase's authorize; the provider calls back
 * to /callback; core exchanges the code server side, mints a V2 session, stores
 * it under a one-time handoff code, and deep-links back to the app; the app
 * calls /complete with the handoff code + its PKCE verifier to receive the
 * session. An intercepted deep link is useless without the in-app verifier.
 */
import crypto from "node:crypto";
import { Hono } from "hono";
import type { AppContext, AppEnv } from "../../types/hono.types";
import { InvalidRequest } from "../../types/oauth.types";
import { gotrue, otc } from "../../services/account/account.service";
import { mintAccountSubjectToken } from "../../services/session.service";
import { createSession } from "../../services/session.service";

const app = new Hono<AppEnv>();

const APP_SCHEME = "com.mentra";
const PROVIDERS = new Set(["google", "apple"]);
const START_TTL_SEC = 10 * 60;
const HANDOFF_TTL_SEC = 60;

function s256(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function publicOrigin(c: AppContext): string {
  return (
    c.req.header("x-mentra-public-origin") ??
    process.env.CORE_PUBLIC_URL ??
    new URL(c.req.url).origin
  );
}

/** Start: persist {state, app challenge} + a core<->GoTrue verifier, redirect
 * into the provider. */
app.get("/:provider/start", async (c) => {
  const provider = c.req.param("provider");
  if (!PROVIDERS.has(provider)) throw new InvalidRequest("unsupported provider");
  const state = c.req.query("state");
  const codeChallenge = c.req.query("code_challenge");
  if (!state || !codeChallenge) throw new InvalidRequest("state and code_challenge required");

  // Core runs its own PKCE leg with GoTrue. The start record is keyed by state.
  const coreVerifier = crypto.randomBytes(32).toString("base64url");
  await otc.issueOAuthStart({
    state,
    ttlSec: START_TTL_SEC,
    payload: { appChallenge: codeChallenge, coreVerifier, provider },
  });

  const redirectTo = `${publicOrigin(c)}/api/account/oauth/callback?state=${encodeURIComponent(state)}`;
  return c.redirect(gotrue.authorizeUrl(provider, redirectTo, s256(coreVerifier)));
});

/** Callback from the provider: exchange the code, mint the session, store it
 * under a one-time handoff code, deep-link back. */
app.get("/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state || !code) throw new InvalidRequest("missing oauth callback params");

  const start = await otc.consumeCode({
    code: state,
    purpose: "oauth_handoff",
    expectSubject: otc.OAUTH_START_SUBJECT,
  });
  const { coreVerifier, appChallenge } = start.payload as {
    coreVerifier: string;
    appChallenge: string;
  };

  const identity = await gotrue.exchangeOAuthCode(code, coreVerifier);
  const subjectToken = await mintAccountSubjectToken({ tenantUserId: identity.id });
  const session = await createSession({ subjectToken });

  // Store the session under a one-time code bound to the APP's PKCE challenge.
  const handoff = await otc.issueOAuthHandoff({
    codeChallenge: appChallenge,
    ttlSec: HANDOFF_TTL_SEC,
    payload: { session },
  });

  return c.redirect(
    `${APP_SCHEME}://auth/callback?code=${encodeURIComponent(handoff)}&state=${encodeURIComponent(state)}`,
  );
});

/** Complete: the app swaps the handoff code + its verifier for the V2 session. */
app.post("/complete", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new InvalidRequest("request body must be a JSON object");
  }
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  if (!code || !codeVerifier) throw new InvalidRequest("code and code_verifier required");

  // consumeCode binds by subject == the stored app challenge, so verify PKCE:
  // recompute S256(verifier) and require it to match the code's subject.
  const consumed = await otc.consumeCode({
    code,
    purpose: "oauth_handoff",
    expectSubject: s256(codeVerifier),
  });
  const { session } = consumed.payload as { session: unknown };
  return c.json(session);
});

export default app;
