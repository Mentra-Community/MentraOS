/**
 * The shared workspace screens (`@mentra/workspace-ui`) must render with this site's React and
 * TanStack Query: a second copy of React gives every hook in them a null dispatcher, and a second
 * TanStack Query a missing QueryClient. The package declares them as peer dependencies, and only
 * the cloud-v2 install links it (the root and sdk workspaces exclude it), so both resolve the same
 * files whichever install ran last.
 */

import {realpathSync} from "node:fs"
import {dirname} from "node:path"

import {expect, test} from "bun:test"

const site = import.meta.dir
const screens = dirname(Bun.resolveSync("@mentra/workspace-ui", site))

for (const name of ["react", "react-dom", "@tanstack/react-query"]) {
  test(`${name} is one copy for this site and @mentra/workspace-ui`, () => {
    expect(realpathSync(Bun.resolveSync(name, screens))).toBe(realpathSync(Bun.resolveSync(name, site)))
  })
}
