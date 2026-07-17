#!/usr/bin/env node
// Decides which miniapp SDK packages should be published on this push, and at
// which npm dist-tag, under the channel-promotion scheme (npm-channel.mjs):
// git holds one prerelease base version per package (only edited on dev), and
// the branch decides what publishes — dev -> X.Y.Z-dev.N (dev tag), staging ->
// X.Y.Z-beta.N (beta tag), main -> X.Y.Z (latest tag). Merging IS promoting;
// no version edits ride the branches.
//
// A package publishes when its DERIVED version for this branch is absent from
// npm (registry-state detection — a promotion merge does not change the
// version field, so git-diff detection cannot see it). Fail-closed rules:
//   - E404 is the only "absent" signal; any other npm error fails the run.
//   - A package that has NEVER been published does not auto-release: its first
//     publish is a supervised workflow_dispatch with force_release=true.
//   - beta/latest publishes land in npm's staging queue (see the workflow):
//     a maintainer approves each version before it goes live, so merging to
//     main IS the go signal and the approval is the only remaining gate.
//   - A package only ships when every internal dep it pins will resolve on
//     this channel (already on npm, or earlier in this run's matrix).
//
// Packages are emitted in dependency order (leaves first) so a max-parallel:1
// matrix publishes them in an order where cross-package pins resolve.
import {readFileSync, appendFileSync} from 'node:fs';
import {channelFor, deriveVersion, publishedVersions, CHANNEL_MANIFESTS} from './npm-channel.mjs';

// Ordered by dependency so a max-parallel:1 matrix publishes in an order where
// downstream pins resolve once their base lands:
//   - the scaffolder's template pins @mentra/miniapp + @mentra/miniapp-cli
//   - the Cloud V2 CLI (@mentra/cli) has a workspace `file:` dep on
//     @mentra/miniapp-cli that the publish job rewrites to an exact version
//     (see .github/scripts/rewrite-file-deps.mjs), so miniapp-cli publishes first.
const PACKAGES = [
  {
    key: 'miniapp',
    name: '@mentra/miniapp',
    dir: 'mobile/modules/miniapp',
    installDir: 'mobile',
    buildCmd: 'bun run build',
  },
  {
    key: 'miniapp-cli',
    name: '@mentra/miniapp-cli',
    dir: 'sdk/miniapp-cli',
    installDir: 'sdk',
    buildCmd: 'bun run build',
  },
  {
    key: 'create',
    name: 'create-mentra-miniapp',
    dir: 'sdk/create-mentra-miniapp',
    installDir: 'sdk',
    buildCmd: '',
    // The scaffolder's template pins these (stamp-template-versions.mjs), so a
    // scaffolded project can only install once they exist on this channel.
    alsoRequires: ['@mentra/miniapp', '@mentra/miniapp-cli'],
  },
  {
    // Cloud V2 auth helper for miniapp backends (JWKS token verification).
    // Leaf package, compiled to dist/ via `tsc -b`, Node-compatible.
    key: 'auth',
    name: '@mentra/auth',
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
    name: '@mentra/cli',
    dir: 'cloud-v2/packages/cli',
    installDir: 'cloud-v2',
    buildCmd: '',
  },
  // ---- @mentra/engine peer closure (see PR #3412): the engine cannot be
  // installed from npm until every package below exists there. Source-TS
  // publishes target Metro consumers; bootstrap order is leaves first:
  // jspolyfill + cloud-protocol -> crust + cloud-client.
  {
    // MentraJS polyfill bundle. crust's android gradle reads its assets/ by a
    // relative path that resolves identically in the monorepo and under an
    // npm-installed @mentra/* sibling layout.
    key: 'jspolyfill',
    name: '@mentra/jspolyfill',
    dir: 'mobile/modules/jspolyfill',
    installDir: 'mobile',
    buildCmd: 'bun run build',
  },
  {
    // Native expo module (QuickJS runtime, navigation, device utilities) +
    // its config plugin carrying the Android build contract.
    key: 'crust',
    name: '@mentra/crust',
    dir: 'mobile/modules/crust',
    installDir: 'mobile',
    buildCmd: 'bun run build',
  },
  {
    // The phone<->cloud wire protocol (schemas/types, zod only) — extracted so
    // cloud-client/engine consumers don't drag the server runtime's deps
    // (ioredis, @soniox/node, hono stay private to the server).
    key: 'cloud-protocol',
    name: '@mentra/cloud-protocol',
    dir: 'cloud-v2/packages/protocol',
    installDir: 'cloud-v2',
    buildCmd: '',
  },
  {
    key: 'cloud-client',
    name: '@mentra/cloud-client',
    dir: 'cloud-v2/packages/cloud-client',
    installDir: 'cloud-v2',
    buildCmd: '',
  },
];

const outputPath = process.env.GITHUB_OUTPUT;
const branch = process.env.GITHUB_REF_NAME || '';
const forceRelease = process.env.FORCE_RELEASE === 'true';
const dryRun = process.env.DRY_RUN === 'true';

function setOutput(name, value) {
  if (!outputPath) {
    console.log(`${name}=${value}`);
    return;
  }
  appendFileSync(outputPath, `${name}=${value}\n`);
}

const {tag} = channelFor(branch); // throws on non-channel branches (e.g. a stray dispatch ref)

// First pass: read every family manifest and its registry state once (also
// covers members outside this pipeline, like the engine, so dep checks can see
// their bases — though nothing here depends on the engine).
const family = {};
// Derived versions guaranteed installable after this run: already on npm, or
// published earlier in this run's max-parallel:1 matrix.
const willExist = new Set();
for (const [name, manifestPath] of Object.entries(CHANNEL_MANIFESTS)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const derived = deriveVersion(manifest.version, branch); // validates the base is a prerelease
  const published = publishedVersions(name);
  family[name] = {manifest, derived, published};
  if (published?.includes(derived)) willExist.add(`${name}@${derived}`);
}

const matrix = [];
const summaryRows = [];

for (const pkg of PACKAGES) {
  const entry = family[pkg.name];
  if (!entry) throw new Error(`${pkg.name} is missing from CHANNEL_MANIFESTS`);
  const base = entry.manifest.version;
  const derived = entry.derived;

  const packageExists = entry.published !== null;
  const versionExists = willExist.has(`${pkg.name}@${derived}`);

  let include = false;
  let reason;
  if (versionExists) {
    reason = 'already on npm';
  } else if (!packageExists && !forceRelease && !dryRun) {
    // Bootstrap gate: a first-ever publish never fires off a push. Dry runs
    // may still include it — the publish steps are dry_run-gated, and the
    // build+pack preview is the point of a dry run.
    reason = 'not on npm yet — bootstrap via workflow_dispatch force_release=true';
    console.log(`::notice::${pkg.name} is not on npm yet; skipping auto-publish. ${reason}.`);
  } else {
    include = true;
    reason = forceRelease ? 'force_release' : 'derived version absent from npm';
  }

  // Installability gate: a package ships only when every internal dep it pins
  // (dependencies + non-optional peers + template pins) will resolve on this
  // channel — either already on npm or published earlier in this same run.
  // Publishing past a bootstrap-gated dep would ship an uninstallable tarball
  // (e.g. @mentra/cli pinning a @mentra/miniapp-cli that is not on npm yet).
  if (include) {
    const required = new Set(pkg.alsoRequires || []);
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const dep of Object.keys(entry.manifest[field] || {})) {
        if (!(dep in CHANNEL_MANIFESTS)) continue;
        if (entry.manifest.peerDependenciesMeta?.[dep]?.optional) continue;
        required.add(dep);
      }
    }
    for (const dep of required) {
      const depDerived = `${dep}@${family[dep].derived}`;
      if (!willExist.has(depDerived)) {
        include = false;
        reason = `waits for ${depDerived} to exist on this channel`;
        console.log(`::notice::${pkg.name}@${derived} skipped: ${reason}.`);
        break;
      }
    }
  }

  if (include) willExist.add(`${pkg.name}@${derived}`);

  if (branch === 'main' && versionExists) {
    console.log(
      `::notice::${pkg.name}@${derived} is already on npm — to cut a new public release, ` +
        `bump the base version on dev and merge it up.`,
    );
  }

  if (include) {
    matrix.push({
      name: pkg.name,
      version: derived,
      tag,
      dir: pkg.dir,
      installDir: pkg.installDir,
      buildCmd: pkg.buildCmd,
    });
  }

  summaryRows.push(
    `${pkg.name}: base ${base} -> ${derived} | tag=${tag} | publish=${include}${include ? '' : ` (${reason})`}`,
  );
}

setOutput('matrix', JSON.stringify(matrix));
setOutput('has_publishes', String(matrix.length > 0));
setOutput('dry_run', String(dryRun));
setOutput('force_release', String(forceRelease));

console.log(`Branch: ${branch} (dist-tag ${tag})`);
for (const row of summaryRows) console.log(row);
console.log(`Publishing ${matrix.length}/${PACKAGES.length} package(s). Dry run: ${dryRun}. Force: ${forceRelease}.`);
