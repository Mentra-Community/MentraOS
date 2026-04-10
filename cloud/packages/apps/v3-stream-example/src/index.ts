import { MiniAppServer, type MentraSession } from "@mentra/sdk";
import { UserSession } from "./backend/session/UserSession";
import { api } from "./backend/api";
import indexHtml from "./frontend/index.html";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME || "dev.mentra.streamtest";
const API_KEY = process.env.MENTRAOS_API_KEY || "";

if (!API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is not set");
  process.exit(1);
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new MiniAppServer({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  verbose: process.env.MENTRA_VERBOSE === "true",
});

app.route("/api", api);

app.onSession((session: MentraSession) => {
  const userId = session.userId;
  if (!userId) {
    console.error("MentraSession connected without a userId");
    return;
  }

  const userSession = UserSession.getOrCreate(userId);
  userSession.attachSession(session);

  session.logger.info(`Session started for ${userId}`);
  session.display.showTextWall(
    "Stream test ready\nUse webview to start stream",
  );

  session.onReconnected(() => {
    session.logger.info(`Session reconnected for ${userId}`);
    userSession.attachSession(session);

    if (userSession.stream.isActive()) {
      session.display.showTextWall("Reconnected — stream still active");
    } else {
      session.display.showTextWall("Reconnected");
    }
  });

  session.onStopped((reason) => {
    session.logger.info(`Session stopped for ${userId}: ${reason}`);
    userSession.detachSession();
  });
});

app.onStop((session, reason) => {
  if (session?.userId) {
    const userSession = UserSession.get(session.userId);
    if (userSession) {
      userSession.detachSession();
    }
  }
});

await app.start();

// ─── Bun fullstack webview server ────────────────────────────────────────────

Bun.serve({
  port: PORT,
  idleTimeout: 255, // max value — SSE connections are long-lived
  development: {
    hmr: true,
    console: true,
  },
  routes: {
    "/": indexHtml,
    "/webview": indexHtml,
    "/webview/*": indexHtml,
  },
  fetch(request: Request) {
    return app.fetch(request);
  },
} as never);

console.log(`Stream test app listening on http://localhost:${PORT}`);
console.log(`Webview: http://localhost:${PORT}/webview`);
console.log("");
console.log("Use the webview to start/stop streams.");
console.log("For direct mode recording, run: bun run record");
console.log("");
