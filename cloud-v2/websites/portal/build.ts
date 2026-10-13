/**
 * Builds the workspace portal into dist/ for Cloudflare Pages.
 *
 * Public build-time configuration, read from the environment (scripts/deploy-pages.ts sets it for each
 * Mentra environment):
 * - DEVELOPER_CONSOLE_URL: the Developer Console the sidebar links to. Unset (a Private Cloud, CI or a
 *   local build): no link.
 */
import tailwind from "bun-plugin-tailwind";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { developerConsoleUrl } from "./src/lib/config";

const configuredConsole = process.env.DEVELOPER_CONSOLE_URL?.trim() ?? "";
const consoleUrl = developerConsoleUrl(configuredConsole);
if (configuredConsole && !consoleUrl) {
  throw new Error(`DEVELOPER_CONSOLE_URL must be an absolute http(s) URL, not "${configuredConsole}".`);
}
console.log(` Developer Console link: ${consoleUrl ?? "none"}`);

const outdir = path.join(process.cwd(), "dist");

/** Red Hat Display weights in public/fonts (the sign-in page's), preloaded so the first render uses them. */
const FONTS = ["/fonts/RedHatDisplay-Regular.ttf", "/fonts/RedHatDisplay-SemiBold.ttf"];

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [...new Bun.Glob("src/**/*.html").scanSync()],
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  // Absolute asset URLs: the app is served for every path (`/w/<workspaceId>/members`), so a relative
  // `./chunk.js` would resolve under the workspace path and get the app's HTML back instead.
  publicPath: "/",
  sourcemap: "linked",
  // The self-hosted fonts are copied from public/fonts. Bun would otherwise inline them as data: URLs.
  external: ["/fonts/*"],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env.DEVELOPER_CONSOLE_URL": JSON.stringify(consoleUrl ?? ""),
  },
});

for (const output of result.outputs) {
  console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
}

await cp(path.join(process.cwd(), "public"), outdir, { recursive: true, force: true });

const htmlPath = path.join(outdir, "index.html");
const html = await readFile(htmlPath, "utf8");
if (!html.includes("</head>")) throw new Error("dist/index.html has no </head> for the font preloads.");
const preloads = FONTS.map(href => `<link rel="preload" href="${href}" as="font" type="font/ttf" crossorigin>`);
await writeFile(htmlPath, html.replace("</head>", `${preloads.join("")}</head>`));
