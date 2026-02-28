import tailwindPlugin from "bun-plugin-tailwind"

const result = await Bun.build({
  entrypoints: ["./src/webview/frontend.tsx"],
  outdir: "./src/webview/dist",
  target: "browser",
  minify: true,
  sourcemap: "external",
  plugins: [tailwindPlugin],
})

if (!result.success) {
  console.error("Build failed")
  for (const message of result.logs) {
    console.error(message)
  }
  process.exit(1)
}

console.log("Build successful!")
for (const output of result.outputs) {
  console.log(`  ${output.path}`)
}
