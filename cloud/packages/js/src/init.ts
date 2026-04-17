/**
 * mentra init — Scaffold a new MentraOS app project
 *
 * Creates the four-folder convention that @mentra/js expects:
 *   client/   runs on the phone (on-device runtime)
 *   webview/  React UI inside the glasses/app WebView
 *   server/   optional Hono app (cloud backend or on-device server code)
 *   shared/   shared TS types
 *
 * Plus:
 *   mentra.config.ts  project config
 *   bunfig.toml       loads the React dedupe plugin (required for dev)
 *   package.json / tsconfig.json
 */

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const name = process.argv[3] || "my-mentra-app";
const dir = join(process.cwd(), name);

if (existsSync(dir)) {
  console.error(`\n  ❌ Directory "${name}" already exists.\n`);
  process.exit(1);
}

console.log(`\n  😎 Creating ${name}...\n`);

mkdirSync(dir, { recursive: true });
mkdirSync(join(dir, "client"));
mkdirSync(join(dir, "webview"));
mkdirSync(join(dir, "server"));
mkdirSync(join(dir, "shared"));

writeFileSync(
  join(dir, "mentra.config.ts"),
  `import { defineConfig } from "@mentra/js";

export default defineConfig({
  packageName: "com.example.${name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}",
  name: "${name}",
  permissions: ["microphone", "display"],
});
`,
);

writeFileSync(
  join(dir, "client", "index.ts"),
  `import { session, state } from "@mentra/js";

state.init({
  transcript: "",
  isListening: false,
});

session.onReady(() => {
  session.display.showTextWall("${name} ready!");

  session.transcription.on((data) => {
    state.set("transcript", data.text);
    session.display.showText(data.text);
  });

  state.set("isListening", true);
});
`,
);

writeFileSync(
  join(dir, "webview", "index.html"),
  `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./App.tsx"></script>
  </body>
</html>
`,
);

writeFileSync(
  join(dir, "webview", "App.tsx"),
  `import { createRoot } from "react-dom/client";
import { useMentra } from "@mentra/js/react";

function App() {
  const { state, connected } = useMentra();

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h1>${name}</h1>
      <p>{connected ? "● Connected" : "○ Connecting..."}</p>
      <p>{state.transcript || "Start speaking..."}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
);

writeFileSync(
  join(dir, "server", "index.ts"),
  `/**
 * server/ — optional Hono app for cloud or on-device backend code.
 *
 * @mentra/js mounts the default export's .fetch() handler after its own
 * /__mentra/* routes. In dev this runs inside the Bun server; on device
 * the same routes will be served by the Island runtime's Hono router.
 *
 * Delete this file if your app is purely client/webview.
 */
import { Hono } from "hono";

const app = new Hono();

app.get("/api/ping", (c) => c.json({ ok: true, from: "${name}" }));

export default app;
`,
);

writeFileSync(
  join(dir, "shared", "types.ts"),
  `export interface AppState {
  transcript: string;
  isListening: boolean;
}
`,
);

writeFileSync(
  join(dir, "bunfig.toml"),
  `# Managed by @mentra/js — feel free to add your own keys.
# The serve.static.plugins array is required for React dedupe in
# the webview bundle (see @mentra/js/src/dedupe-plugin.ts).

[serve.static]
plugins = ["@mentra/js/dedupe-plugin"]
`,
);

writeFileSync(
  join(dir, "package.json"),
  JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "mentra dev",
        build: "mentra build",
      },
      dependencies: {
        "@mentra/js": "^0.1.0",
        "hono": "^4.11.3",
        "react": "^19",
        "react-dom": "^19",
      },
      devDependencies: {
        "@types/react": "^19",
        "@types/react-dom": "^19",
        "typescript": "^5",
      },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        jsx: "react-jsx",
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ["client", "webview", "server", "shared"],
    },
    null,
    2,
  ) + "\n",
);

console.log(`  ✅ Created ${name}/`);
console.log("");
console.log(`  Next steps:`);
console.log(`    cd ${name}`);
console.log(`    bun install`);
console.log(`    mentra dev`);
console.log("");
