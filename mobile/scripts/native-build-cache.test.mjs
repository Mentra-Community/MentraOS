import {test} from "node:test"
import assert from "node:assert/strict"
import {cacheScope} from "./native-build-cache.mjs"

test("native cache scope isolates workspace, tools, dependencies and runtime environment", () => {
  const base = {workspace: "/build/repo", xcode: "26.2", node: "20", bun: "1.4", environment: {backend: "dev"}, dependencies: "lock1"}
  for (const key of Object.keys(base)) assert.notEqual(cacheScope(base), cacheScope({...base, [key]: "changed"}))
  assert.equal(cacheScope(base), cacheScope({...base}))
})
