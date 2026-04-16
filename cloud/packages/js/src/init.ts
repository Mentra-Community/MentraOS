/**
 * mentra init — Scaffold a new MentraOS app project
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
mkdirSync(join(dir, "shared"));

writeFileSync(join(dir, "mentra.config.ts"), `import { defineConfig } from "@mentra/js";

export default defineConfig({
  packageName: "com.example.${name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}",
  name: "${name}",
  permissions: ["microphone", "display"],
});
`);

writeFileSync(join(dir, "client", "index.ts"), `import { session, state } from "@mentra/js";

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
`);

writeFileSync(join(dir, "webview", "index.html"), `<!DOCTYPE html>
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
`);

writeFileSync(join(dir, "webview", "App.tsx"), `import { createRoot } from "react-dom/client";
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
`);

writeFileSync(join(dir, "shared", "types.ts"), `export interface AppState {
  transcript: string;
  isListening: boolean;
}
`);

writeFileSync(join(dir, "package.json"), JSON.stringify({
  name,
  version: "0.1.0",
  private: true,
  scripts: {
    dev: "mentra dev",
    build: "mentra build",
  },
  dependencies: {
    "@mentra/js": "workspace:*",
    "react": "^19",
    "react-dom": "^19",
  },
  devDependencies: {
    "@types/react": "^19",
    "typescript": "^5",
  },
}, null, 2) + "\n");

writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    jsx: "react-jsx",
    esModuleInterop: true,
    skipLibCheck: true,
  },
  include: ["client", "webview", "shared"],
}, null, 2) + "\n");

console.log(`  ✅ Created ${name}/`);
console.log("");
console.log(`  Next steps:`);
console.log(`    cd ${name}`);
console.log(`    bun install`);
console.log(`    mentra dev`);
console.log("");
