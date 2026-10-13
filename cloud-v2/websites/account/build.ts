/**
 * Builds the Mentra account site into dist/ for Cloudflare Pages.
 *
 * Each environment's sign-in site (account.dev, account.staging and account
 * .mentraglass.com) is this build, with the provider's routes relayed to that
 * environment's Core by the Pages Function in functions/.
 *
 * Public build-time configuration, read from the environment:
 * - SUPABASE_URL: the Supabase project URL (hosted: https://auth.mentra.glass).
 * - SUPABASE_ANON_KEY: the project's publishable key.
 *
 * Both may be unset (CI builds without configuration). The sign-in routes then
 * show "Sign-in is not configured.".
 */
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHeadersFile, supabaseOrigin } from "./src/lib/headers";

export { buildHeadersFile } from "./src/lib/headers";

const root = import.meta.dir;
const outdir = path.join(root, "dist");

/** Red Hat Display weights in public/fonts, preloaded so the first render uses them. */
const FONTS = ["/fonts/RedHatDisplay-Regular.ttf", "/fonts/RedHatDisplay-SemiBold.ttf"];

const config = {
  SUPABASE_URL: (process.env.SUPABASE_URL ?? "").trim(),
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY ?? "").trim(),
};

async function build() {
  // Fails early on a malformed SUPABASE_URL.
  const origin = supabaseOrigin(config.SUPABASE_URL);
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    console.warn("SUPABASE_URL or SUPABASE_ANON_KEY is unset: the site will show \"Sign-in is not configured.\"");
  }

  await rm(outdir, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [path.join(root, "src/index.html")],
    outdir,
    publicPath: "/",
    minify: true,
    target: "browser",
    sourcemap: "linked",
    // The self-hosted fonts are copied from public/fonts. Bun would otherwise
    // inline them as data: URLs, which the CSP does not allow.
    external: ["/fonts/*"],
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.SUPABASE_URL": JSON.stringify(config.SUPABASE_URL),
      "process.env.SUPABASE_ANON_KEY": JSON.stringify(config.SUPABASE_ANON_KEY),
    },
  });

  for (const output of result.outputs) {
    console.log(` ${path.relative(root, output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
  }

  await cp(path.join(root, "public"), outdir, { recursive: true, force: true });
  const htmlPath = path.join(outdir, "index.html");
  const html = await readFile(htmlPath, "utf8");
  if (!html.includes("</head>")) throw new Error("dist/index.html has no </head> for the font preloads.");
  const preloads = FONTS.map((href) => `<link rel="preload" href="${href}" as="font" type="font/ttf" crossorigin>`);
  await writeFile(htmlPath, html.replace("</head>", `${preloads.join("")}</head>`));
  await writeFile(path.join(outdir, "_headers"), buildHeadersFile(config.SUPABASE_URL));
  console.log(` dist/_headers  connect-src 'self' ${origin}`);
}

if (import.meta.main) {
  await build();
}
