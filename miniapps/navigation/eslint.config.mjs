/**
 * Local ESLint flat-config override.
 *
 * The workspace eslint config wires `eslint-import-resolver-typescript` to
 * the repository-wide TypeScript projects, so it can't see the
 * `@/*` path alias declared in this folder's tsconfig.json. Without this
 * override, `import {X} from "@/..."` lights up "Unable to resolve" even
 * though TS itself resolves fine.
 *
 * We extend the workspace config and add our tsconfig to the resolver
 * project list. No rule changes — only resolver wiring.
 */

import path from "node:path"
import {fileURLToPath} from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    settings: {
      "import/resolver": {
        typescript: {
          project: path.join(__dirname, "tsconfig.json"),
        },
      },
    },
  },
]
