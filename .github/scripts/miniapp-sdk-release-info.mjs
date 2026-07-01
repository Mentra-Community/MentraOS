#!/usr/bin/env node
// Decides which miniapp SDK packages should be published on this push, and at
// which npm dist-tag. Mirrors the bluetooth-sdk-release-info.mjs convention:
// publish a package only when the `version` field in its package.json changed
// between the push's before-SHA and HEAD (or when force-released via dispatch).
//
// The dist-tag is derived from the version's prerelease label so the tag can
// never drift from the version — matching how @mentra/sdk already ships:
//   1.2.3            -> latest      (production)
//   1.2.3-beta.4     -> beta        (staging)
//   1.2.3-dev.4      -> dev         (dev)
//   1.2.3-alpha.4    -> alpha
//   1.2.3-<label>.N  -> <label>
//
// Packages are emitted in dependency order (miniapp, cli, scaffolder) so a
// max-parallel:1 matrix publishes them in an order where the scaffolder's
// template pins resolve once it runs.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

// Ordered by dependency so a max-parallel:1 matrix publishes in an order where
// downstream pins resolve once their base lands:
//   - the scaffolder's template pins @mentra/miniapp + @mentra/miniapp-cli
//   - the Cloud V2 CLI (@mentra/cli) has a workspace `file:` dep on
//     @mentra/miniapp-cli that the publish job rewrites to an exact version
//     (see .github/scripts/rewrite-file-deps.mjs), so miniapp-cli publishes first.
const PACKAGES = [
  {
    key: 'miniapp',
    path: 'mobile/modules/miniapp/package.json',
    dir: 'mobile/modules/miniapp',
    installDir: 'mobile',
    buildCmd: 'bun run build',
  },
  {
    key: 'miniapp-cli',
    path: 'sdk/miniapp-cli/package.json',
    dir: 'sdk/miniapp-cli',
    installDir: 'sdk',
    buildCmd: 'bun run build',
  },
  {
    key: 'create',
    path: 'sdk/create-mentra-miniapp/package.json',
    dir: 'sdk/create-mentra-miniapp',
    installDir: 'sdk',
    buildCmd: '',
  },
  {
    // Cloud V2 auth helper for miniapp backends (JWKS token verification).
    // Leaf package, compiled to dist/ via `tsc -b`, Node-compatible.
    key: 'auth',
    path: 'cloud-v2/packages/auth/package.json',
    dir: 'cloud-v2/packages/auth',
    installDir: 'cloud-v2',
    buildCmd: 'bun run build',
  },
  {
    // Cloud V2 developer CLI (`mentra`). Wraps @mentra/miniapp-cli (dev/build/pack)
    // and adds login / org / miniapps / releases / publish. Bun-only, no build
    // step (ships raw .ts under a `#!/usr/bin/env bun` shebang). Its `file:` dep
    // on @mentra/miniapp-cli is rewritten to an exact version before packing, so
    // it must come after miniapp-cli in this list.
    key: 'cli',
    path: 'cloud-v2/packages/cli/package.json',
    dir: 'cloud-v2/packages/cli',
    installDir: 'cloud-v2',
    buildCmd: '',
  },
];

const outputPath = process.env.GITHUB_OUTPUT;
const eventName = process.env.GITHUB_EVENT_NAME || '';
const eventPath = process.env.GITHUB_EVENT_PATH;
const branch = process.env.GITHUB_REF_NAME || '';
const forceRelease = process.env.FORCE_RELEASE === 'true';
const dryRun = process.env.DRY_RUN === 'true';

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
  }).trim();
}

function readJsonAt(ref, path) {
  try {
    return JSON.parse(git(['show', `${ref}:${path}`]));
  } catch {
    return null;
  }
}

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`);
    return;
  }
  execFileSync('bash', ['-lc', 'cat >> "$GITHUB_OUTPUT"'], {
    input: `${name}=${value}\n`,
    env: process.env,
  });
}

// 1.2.3 -> latest, 1.2.3-beta.4 -> beta, 1.2.3-dev.1 -> dev, etc.
function distTagFor(version) {
  const dash = version.indexOf('-');
  if (dash === -1) return 'latest';
  const label = version.slice(dash + 1).split('.')[0].toLowerCase();
  return label || 'latest';
}

let beforeSha = '';
if (eventPath) {
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    beforeSha = event.before || '';
  } catch {
    beforeSha = '';
  }
}
if (/^0+$/.test(beforeSha)) beforeSha = '';

const matrix = [];
const summaryRows = [];

for (const pkg of PACKAGES) {
  const current = JSON.parse(readFileSync(pkg.path, 'utf8'));
  if (!current.name) throw new Error(`Missing name in ${pkg.path}`);
  if (!current.version) throw new Error(`Missing version in ${pkg.path}`);

  const previous = beforeSha ? readJsonAt(beforeSha, pkg.path) : null;
  const previousVersion = previous?.version || '';
  const versionChanged = Boolean(previousVersion) && previousVersion !== current.version;
  const include = versionChanged || forceRelease;

  const tag = distTagFor(current.version);

  // Guardrail: a plain (non-prerelease) version publishes to `latest`, which is
  // what `npm install` resolves by default. Never let that happen off `main`.
  if (include && tag === 'latest' && branch && branch !== 'main') {
    throw new Error(
      `${current.name}@${current.version} would publish to the "latest" dist-tag from branch "${branch}". ` +
        `Production releases (no prerelease label) must land on main. Use a -dev / -beta prerelease here.`,
    );
  }
  if (include && branch === 'staging' && tag !== 'beta') {
    console.log(`::warning::${current.name}@${current.version} on staging resolves to dist-tag "${tag}" (expected "beta").`);
  }
  if (include && branch === 'dev' && !['dev', 'alpha'].includes(tag)) {
    console.log(`::warning::${current.name}@${current.version} on dev resolves to dist-tag "${tag}" (expected "dev" or "alpha").`);
  }

  if (include) {
    matrix.push({
      name: current.name,
      version: current.version,
      tag,
      dir: pkg.dir,
      installDir: pkg.installDir,
      buildCmd: pkg.buildCmd,
    });
  }

  summaryRows.push(
    `${current.name}: ${previousVersion || '(none)'} -> ${current.version} | changed=${versionChanged} | tag=${tag} | publish=${include}`,
  );
  console.log(summaryRows[summaryRows.length - 1]);
}

setOutput('matrix', JSON.stringify(matrix));
setOutput('has_publishes', String(matrix.length > 0));
setOutput('dry_run', String(dryRun));

if (outputPath) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const body = ['## Miniapp SDK release decision', '', '```', ...summaryRows, '```', ''].join('\n');
    execFileSync('bash', ['-lc', 'cat >> "$GITHUB_STEP_SUMMARY"'], {input: body, env: process.env});
  }
}
