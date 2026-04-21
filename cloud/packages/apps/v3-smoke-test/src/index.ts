import { createAuthMiddleware, getMentraAuth, MiniAppServer, type MentraSession } from "@mentra/sdk";

import { api as backendApi } from "./backend/api";
import { UserSession } from "./backend/UserSession";
import indexHtml from "./frontend/index.html";

const PORT = Number.parseInt(process.env.PORT || "3335", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || "dev.mentra.v3-smoke-test";
const API_KEY = process.env.MENTRAOS_API_KEY || "";
const COOKIE_SECRET = process.env.COOKIE_SECRET || API_KEY;

if (!API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is not set");
  process.exit(1);
}

if (!COOKIE_SECRET || COOKIE_SECRET.length < 8) {
  console.error("COOKIE_SECRET environment variable must be at least 8 characters");
  process.exit(1);
}

const app = new MiniAppServer({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  cookieSecret: COOKIE_SECRET,
});

const authMiddleware = createAuthMiddleware({
  apiKey: API_KEY,
  packageName: PACKAGE_NAME,
  cookieSecret: COOKIE_SECRET,
});

app.use("/api/state/*", authMiddleware);
app.route("/api", backendApi);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    packageName: PACKAGE_NAME,
    runtime: "sdk-v3-smoke-test",
  }),
);

app.get("/api/me", authMiddleware, (c) => {
  const auth = getMentraAuth(c);
  const userId = auth.userId;
  if (!userId) {
    return c.json({ error: "Unauthenticated" }, 401);
  }

  const snapshot = UserSession.get(userId)?.getSnapshot() ?? null;

  return c.json({
    userId,
    hasCookie: true,
    runtimeSessionId: snapshot?.runtime.sessionId ?? null,
    runtimeStatus: snapshot?.runtime.status ?? "missing",
    hasRuntimeSession: auth.session !== null || UserSession.get(userId)?.hasActiveSession() === true,
  });
});

app.get("/api/me-via-token", authMiddleware, (c) => {
  const auth = getMentraAuth(c);
  const userId = auth.userId;
  if (!userId) {
    return c.json({ error: "Unauthenticated" }, 401);
  }

  const snapshot = UserSession.get(userId)?.getSnapshot() ?? null;

  return c.json({
    userId,
    hasCookie: false,
    runtimeSessionId: snapshot?.runtime.sessionId ?? null,
    runtimeStatus: snapshot?.runtime.status ?? "missing",
    hasRuntimeSession: auth.session !== null || UserSession.get(userId)?.hasActiveSession() === true,
  });
});

app.onSession((session: MentraSession) => {
  wireSession(session);
});

app.onStop((session, reason) => {
  console.log("Session stopped", {
    reason,
    sessionId: session?.sessionId ?? null,
    userId: session?.userId ?? null,
  });
});

await app.start();

const publicPath = `${process.cwd()}/src/public/assets`;
const isDevelopment = process.env.NODE_ENV === "development";

Bun.serve({
  port: PORT,
  development: isDevelopment
    ? {
        hmr: true,
        console: true,
      }
    : false,
  routes: {
    "/": indexHtml,
    "/webview": indexHtml,
    "/webview/*": indexHtml,
  },
  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/")) {
      const filePath = `${publicPath}${url.pathname.replace("/assets", "")}`;
      return new Response(Bun.file(filePath));
    }

    return app.fetch(request);
  },
} as never);

console.log(`v3 smoke test mini app listening on http://localhost:${PORT}`);

function wireSession(session: MentraSession): void {
  const userId = session.userId;
  if (!userId) {
    console.error("MentraSession connected without a userId");
    return;
  }

  const userSession = UserSession.getOrCreate(userId);
  userSession.attachSession(session);
  session.display.showDoubleTextWall("THIS IS THE FIRST PART", "THIS IS THE SECOND PART");

  // console.log("Session connected", {
  //   sessionId: session.sessionId,
  //   userId,
  // })
  session.logger.info(
    {
      sessionId: session.sessionId,
      userId,
    },
    `MentraSession connected for ${userId}, sessionId: ${session.sessionId}`,
  );

  session.onReconnected(() => {
    userSession.markReconnected(session);
    session.logger.info(
      {
        sessionId: session.sessionId,
        userId,
      },
      `MentraSession reconnected for ${userId}, sessionId: ${session.sessionId}`,
    );
    // console.log("Session reconnected", {
    //   sessionId: session.sessionId,
    //   userId,
    // })

    // session.display.showTextWall("Reconnected")
  });

  session.onStopped((reason) => {
    userSession.markStopped(reason);

    session.logger.info(
      {
        sessionId: session.sessionId,
        userId,
        reason,
      },
      `MentraSession stopped for ${userId}, sessionId: ${session.sessionId}, reason: ${reason}`,
    );
  });

  session.transcription.configure({
    languageHints: ["en"],
    diarization: true,
  });

  session.transcription.on((data) => {
    if (!data.text) {
      return;
    }

    userSession.applyTranscription(data);
    const prefix = data.isFinal ? "Final" : "Live";
    session.display.showTextWall(`${prefix}: ${data.text}`);
  });

  session.display.showTextWall("v3 smoke test ready");
}
