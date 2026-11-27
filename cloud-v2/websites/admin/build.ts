import tailwind from "bun-plugin-tailwind";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
  sourcemap: "linked",
  // The self-hosted fonts are copied from public/fonts. Bun would otherwise inline them as data: URLs.
  // /api/* is Core's, reached at run time: the Fleet page imports its UI module from /api/admin/fleet/ui/.
  // The bundler must never try to resolve or inline that.
  external: ["/fonts/*", "/api/*"],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
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
