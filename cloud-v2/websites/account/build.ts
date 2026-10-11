/**
 * Builds the Mentra account site into dist/ for Cloudflare Pages.
 *
 * Public build-time configuration, read from the environment:
 * - SUPABASE_URL: the Supabase project URL (hosted: https://auth.mentra.glass).
 * - SUPABASE_ANON_KEY: the project's publishable key.
 * - FIRST_PARTY_CLIENT_IDS: comma-separated OAuth client IDs approved without consent.
 *
 * All three may be unset (CI builds without configuration). The site then
 * shows "Sign-in is not configured." on every route.
 */
import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHeadersFile, supabaseOrigin } from "./src/lib/headers";

export { buildHeadersFile } from "./src/lib/headers";

const root = import.meta.dir;
const outdir = path.join(root, "dist");

const config = {
  SUPABASE_URL: (process.env.SUPABASE_URL ?? "").trim(),
  SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY ?? "").trim(),
  FIRST_PARTY_CLIENT_IDS: (process.env.FIRST_PARTY_CLIENT_IDS ?? "").trim(),
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
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.SUPABASE_URL": JSON.stringify(config.SUPABASE_URL),
      "process.env.SUPABASE_ANON_KEY": JSON.stringify(config.SUPABASE_ANON_KEY),
      "process.env.FIRST_PARTY_CLIENT_IDS": JSON.stringify(config.FIRST_PARTY_CLIENT_IDS),
    },
  });

  for (const output of result.outputs) {
    console.log(` ${path.relative(root, output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
  }

  await cp(path.join(root, "public"), outdir, { recursive: true, force: true });
  await writeFile(path.join(outdir, "_headers"), buildHeadersFile(config.SUPABASE_URL));
  console.log(` dist/_headers  connect-src 'self' ${origin}`);
}

if (import.meta.main) {
  await build();
}
