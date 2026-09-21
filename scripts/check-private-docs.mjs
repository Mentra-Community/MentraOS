#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Public integration documentation is intentionally maintained with the code.
const PUBLIC_REFERENCES = new Set([
  'mintlify-docs/glasses-oems/firmware-spec.mdx',
]);

const RETIRED_DIRECTORIES = [
  'agents/',
  'notes/',
  'cloud-v2/docs/',
  'mobile/agents/',
  'mobile/docs/pr/',
  'mobile/modules/acs-meeting/spike/',
  'asg_client/docs/agents/',
  'asg_client/docs/fps-thermal-test/',
];

const RETIRED_FILES = new Set([
  'COLE_LOG_AUDIT_TODO.md',
  'asg_client/docs/mentra-live-spec.md',
  'asg_client/docs/mentra-live-whip-battery-tests.md',
  'mobile/docs/migration-zipline-to-dokar3.md',
  'mobile/MENTRA_LIVE_MIC_FLOW_DIAGRAM.txt',
]);

export function isPrivateDocPath(path) {
  if (PUBLIC_REFERENCES.has(path)) return false;
  if (RETIRED_FILES.has(path) || RETIRED_DIRECTORIES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if (!/\.(md|mdx|rst|txt|pdf|docx)$/i.test(path)) return false;
  if (/(^|\/)(superpowers|specs|plans|prds|handoffs)(\/|$)/i.test(path)) return true;
  const filename = path.split('/').at(-1);
  return /(^|[-_])(spec|specification|design|plan|planning)([-_.]|$)/i.test(filename);
}

export function checkPaths(paths) {
  return paths.filter(isPrivateDocPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Read the index, including tracked files hidden by .gitignore. No private
  // repository or credential is needed; public/fork CI stays self-contained.
  const paths = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
  const violations = checkPaths(paths);
  if (violations.length) {
    console.error('Internal specs and planning files belong in the private Mentra-Specs repository:');
    for (const path of violations) console.error(`  ${path}`);
    console.error('Read AGENTS.md for the shared workflow. Public API references need an explicit exception.');
    process.exitCode = 1;
  } else {
    console.log('Private documentation boundary passed. This path check does not classify confidential prose.');
  }
}
