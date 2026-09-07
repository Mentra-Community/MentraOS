import assert from "node:assert/strict"
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

import {
  evaluateAutolinkingCache,
  normalizeAutolinkingGraph,
  parseApplicationId,
  syncAutolinkingCache,
} from "./clear-autolinking-cache.mjs"

function graph({
  packageName = "com.mentra.mentra",
  reactNativePath = "/rn",
  dependencies = {
    "workspace-mod": {
      root: "/modules/workspace-mod",
      platforms: {android: {sourceDir: "/modules/workspace-mod/android", cmakeListsPath: "CMakeLists.txt"}},
    },
    "other-mod": {
      root: "/node_modules/other-mod",
      platforms: {android: {sourceDir: "/node_modules/other-mod/android"}},
    },
  },
} = {}) {
  return {
    reactNativePath,
    project: {android: {packageName}},
    dependencies,
  }
}

const ENTRY = `
public class ReactNativeApplicationEntryPoint {
  public static void loadReactNative(Context context) {
    if (com.mentra.mentra.BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
    }
  }
}
`

test("identical graphs normalize identically regardless of key insertion order", () => {
  const first = graph()
  const second = {
    reactNativePath: first.reactNativePath,
    project: first.project,
    dependencies: {
      "other-mod": first.dependencies["other-mod"],
      "workspace-mod": first.dependencies["workspace-mod"],
    },
  }
  assert.equal(normalizeAutolinkingGraph(first), normalizeAutolinkingGraph(second))
})

test("adding or removing a dependency changes the normalization", () => {
  const base = graph()
  const added = graph({
    dependencies: {
      ...base.dependencies,
      "new-mod": {root: "/new", platforms: {android: {sourceDir: "/new/android"}}},
    },
  })
  const removed = graph({
    dependencies: {
      "workspace-mod": base.dependencies["workspace-mod"],
    },
  })
  assert.notEqual(normalizeAutolinkingGraph(base), normalizeAutolinkingGraph(added))
  assert.notEqual(normalizeAutolinkingGraph(base), normalizeAutolinkingGraph(removed))
})

test("changing a workspace module android config changes the normalization", () => {
  const base = graph()
  const changed = graph({
    dependencies: {
      ...base.dependencies,
      "workspace-mod": {
        root: "/modules/workspace-mod",
        platforms: {android: {sourceDir: "/modules/workspace-mod/android-new", cmakeListsPath: "CMakeLists.txt"}},
      },
    },
  })
  assert.notEqual(normalizeAutolinkingGraph(base), normalizeAutolinkingGraph(changed))
})

test("changing packageName changes the normalization", () => {
  assert.notEqual(normalizeAutolinkingGraph(graph()), normalizeAutolinkingGraph(graph({packageName: "com.mentra"})))
})

test("null or missing packageName is surfaced as null", () => {
  const missing = normalizeAutolinkingGraph({project: {android: {}}, dependencies: {}})
  const empty = normalizeAutolinkingGraph({project: {android: {packageName: ""}}, dependencies: {}})
  assert.match(missing, /"packageName":null/)
  assert.match(empty, /"packageName":null/)
})

test("entry-point package mismatch is reported dirty", () => {
  const resolved = graph()
  const decision = evaluateAutolinkingCache({
    cached: resolved,
    resolved,
    entryPointSource: "if (com.mentra.BuildConfig.IS_NEW_ARCHITECTURE_ENABLED)",
    packageListExists: true,
  })
  assert.deepEqual(decision, {wiped: true, reason: "entry-point"})
})

test("scenario 1: identical live graph keeps generated sources", () => {
  const resolved = graph()
  const decision = evaluateAutolinkingCache({
    cached: resolved,
    resolved,
    entryPointSource: ENTRY,
    packageListExists: true,
  })
  assert.deepEqual(decision, {wiped: false, reason: "clean"})
})

test("scenario 2: stale com.mentra packageName wipes", () => {
  const resolved = graph({packageName: "com.mentra.mentra"})
  const cached = graph({packageName: "com.mentra"})
  const decision = evaluateAutolinkingCache({
    cached,
    resolved,
    entryPointSource: ENTRY,
    packageListExists: true,
  })
  assert.deepEqual(decision, {wiped: true, reason: "packageName"})
})

test("scenario 3: added or removed dependency wipes for graph drift", () => {
  const cached = graph()
  const resolved = graph({
    dependencies: {
      ...cached.dependencies,
      "new-mod": {root: "/new", platforms: {android: {sourceDir: "/new/android"}}},
    },
  })
  const decision = evaluateAutolinkingCache({
    cached,
    resolved,
    entryPointSource: ENTRY,
    packageListExists: true,
  })
  assert.deepEqual(decision, {wiped: true, reason: "graph"})
})

test("scenario 4: workspace android config change with unchanged lockfile wipes", () => {
  const cached = graph()
  const resolved = graph({
    dependencies: {
      ...cached.dependencies,
      "workspace-mod": {
        root: "/modules/workspace-mod",
        platforms: {android: {sourceDir: "/modules/workspace-mod/android", cmakeListsPath: "other.cmake"}},
      },
    },
  })
  const decision = evaluateAutolinkingCache({
    cached,
    resolved,
    entryPointSource: ENTRY,
    packageListExists: true,
  })
  assert.deepEqual(decision, {wiped: true, reason: "graph"})
})

test("scenario 5: null packageName or resolver failure is unresolved and dirty", () => {
  const cached = graph()
  assert.deepEqual(
    evaluateAutolinkingCache({
      cached,
      resolved: graph({packageName: null}),
      entryPointSource: ENTRY,
      packageListExists: true,
    }),
    {wiped: true, reason: "unresolved"},
  )
  assert.deepEqual(
    evaluateAutolinkingCache({
      cached,
      resolveError: new Error("resolver exited 1"),
      entryPointSource: ENTRY,
      packageListExists: true,
    }),
    {wiped: true, reason: "unresolved"},
  )
})

test("missing cached graph is not a wipe", () => {
  assert.deepEqual(evaluateAutolinkingCache({cached: null, resolved: graph()}), {
    wiped: false,
    reason: "nothing-cached",
  })
})

test("parseApplicationId reads defaultConfig applicationId", () => {
  assert.equal(
    parseApplicationId(`
android {
    defaultConfig {
        applicationId 'com.mentra.mentra.stable'
        versionCode 1
    }
}
`),
    "com.mentra.mentra.stable",
  )
  assert.equal(parseApplicationId('        applicationId "com.mentra.mentra"\n'), "com.mentra.mentra")
  assert.equal(parseApplicationId("// applicationId 'com.mentra.mentra.stable'\n"), null)
  assert.equal(parseApplicationId(undefined), null)
})

test("generated applicationId suffix drift wipes even when the resolver stays on the base package", () => {
  const resolved = graph()
  const decision = evaluateAutolinkingCache({
    cached: resolved,
    resolved,
    entryPointSource: ENTRY,
    packageListExists: true,
    effectivePackageName: "com.mentra.mentra.stable",
  })
  assert.deepEqual(decision, {wiped: true, reason: "packageName"})
})

test("matching generated applicationId stays clean", () => {
  const resolved = graph()
  const decision = evaluateAutolinkingCache({
    cached: resolved,
    resolved,
    entryPointSource: ENTRY,
    packageListExists: true,
    effectivePackageName: "com.mentra.mentra",
  })
  assert.deepEqual(decision, {wiped: false, reason: "clean"})
})

async function withAutolinkingFixture(cachedGraph, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "autolink-guard-"))
  const cachedPath = join(root, "android/build/generated/autolinking/autolinking.json")
  const entryPath = join(
    root,
    "android/app/build/generated/autolinking/src/main/java/com/facebook/react/ReactNativeApplicationEntryPoint.java",
  )
  const packageListPath = join(
    root,
    "android/app/build/generated/autolinking/src/main/java/com/facebook/react/PackageList.java",
  )
  await mkdir(join(root, "android/build/generated/autolinking"), {recursive: true})
  await mkdir(join(root, "android/app/build/generated/autolinking/src/main/java/com/facebook/react"), {recursive: true})
  await mkdir(join(root, "android/app"), {recursive: true})
  await writeFile(cachedPath, JSON.stringify(cachedGraph))
  await writeFile(entryPath, extra.entryPointSource ?? ENTRY)
  await writeFile(packageListPath, "class PackageList {}")
  if (extra.applicationId) {
    await writeFile(
      join(root, "android/app/build.gradle"),
      `android {\n    defaultConfig {\n        applicationId '${extra.applicationId}'\n    }\n}\n`,
    )
  }
  return root
}

test("syncAutolinkingCache scenario 2: stale cached packageName wipes the fixture", async () => {
  const root = await withAutolinkingFixture(graph({packageName: "com.mentra"}))
  try {
    const decision = await syncAutolinkingCache({
      cwd: root,
      resolve: async () => graph({packageName: "com.mentra.mentra"}),
      log() {},
    })
    assert.deepEqual(decision, {wiped: true, reason: "packageName"})
    await assert.rejects(
      import("node:fs/promises").then((fs) =>
        fs.access(join(root, "android/build/generated/autolinking/autolinking.json")),
      ),
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test("syncAutolinkingCache scenario 3 and 4: graph drift wipes", async () => {
  const cached = graph()
  const root = await withAutolinkingFixture(cached)
  try {
    const decision = await syncAutolinkingCache({
      cwd: root,
      resolve: async () =>
        graph({
          dependencies: {
            ...cached.dependencies,
            "new-mod": {root: "/new", platforms: {android: {sourceDir: "/new/android"}}},
          },
        }),
      log() {},
    })
    assert.deepEqual(decision, {wiped: true, reason: "graph"})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test("syncAutolinkingCache scenario 5: resolver failure wipes", async () => {
  const root = await withAutolinkingFixture(graph())
  try {
    const decision = await syncAutolinkingCache({
      cwd: root,
      resolve: async () => {
        throw new Error("resolver exited 1")
      },
      log() {},
    })
    assert.deepEqual(decision, {wiped: true, reason: "unresolved"})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test("syncAutolinkingCache wipes when generated applicationId drifted from the resolver", async () => {
  const cached = graph()
  const root = await withAutolinkingFixture(cached, {applicationId: "com.mentra.mentra.stable"})
  try {
    const decision = await syncAutolinkingCache({
      cwd: root,
      resolve: async () => cached,
      log() {},
    })
    assert.deepEqual(decision, {wiped: true, reason: "packageName"})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test("syncAutolinkingCache keeps a matching fixture", async () => {
  const cached = graph()
  const root = await withAutolinkingFixture(cached)
  try {
    const decision = await syncAutolinkingCache({
      cwd: root,
      resolve: async () => cached,
      log() {},
    })
    assert.deepEqual(decision, {wiped: false, reason: "clean"})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
