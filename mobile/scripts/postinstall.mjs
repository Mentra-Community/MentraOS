#!/usr/bin/env zx

console.log('Running postinstall...');

// Workspace setup hoists deps to root node_modules — per-module `bun install`
// is no longer needed and re-introduced duplicate react/react-native copies.

// supabase-js >= 2.106 inlines an `import(/* webpackIgnore: true */ ...)` call
// for optional OpenTelemetry tracing. Hermes can't parse that in iOS release
// bundles. Neutralize the dynamic import to a Promise that resolves to null —
// the calling code already handles that as "OTel not available". Idempotent.
{
  const fs = await import('fs');
  for (const rel of ['node_modules/@supabase/supabase-js/dist/index.cjs',
                     'node_modules/@supabase/supabase-js/dist/index.mjs']) {
    if (!fs.existsSync(rel)) continue;
    const before = fs.readFileSync(rel, 'utf8');
    // Match the whole `if (otelModulePromise === null) otelModulePromise = …;`
    // statement and replace the RHS with a no-op resolved-null promise. Anchors
    // on the unique `otelModulePromise === null` check so we don't mis-match.
    const after = before.replace(
      /(otelModulePromise === null\)\s*otelModulePromise = )[^\n;]+;/g,
      '$1Promise.resolve(null);',
    );
    if (after !== before) {
      fs.writeFileSync(rel, after);
      console.log(`  patched ${rel}`);
    }
  }
}

await $({ stdio: 'inherit', cwd: 'modules/bluetooth-sdk' })`bun run prepare`;
await $({ stdio: 'inherit', cwd: 'modules/crust' })`bun run prepare`;
await $({ stdio: 'inherit', cwd: 'modules/miniapp' })`bun run prepare`;
// island depends on bluetooth-sdk + miniapp build outputs, so its prepare
// (renamed to build:module) runs here instead of being auto-triggered by bun
// install in parallel with its workspace deps.
await $({ stdio: 'inherit', cwd: 'modules/island' })`bun run build:module`;

// ignore scripts to avoid infinite loop:
// await $({ stdio: 'inherit' })`bun install --ignore-scripts`;

console.log('✅ Postinstall completed successfully!');
