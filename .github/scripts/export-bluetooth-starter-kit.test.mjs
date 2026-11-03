import assert from "node:assert/strict"
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {fileURLToPath} from "node:url"

import {
  exportCoordinates,
  guardStarterKit,
  kitLink,
  releaseContainer,
  releaseRecordUrl,
  sourceReferences,
  transformStarterKit,
  verifyPatchedLockfile,
} from "./export-bluetooth-starter-kit.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const identity = "3.4.0-dev.1040"
const commit = "c".repeat(40)

function releaseRecord(overrides = {}) {
  const id = overrides.releaseIdentity || identity
  return {
    schemaVersion: 1,
    releaseIdentity: id,
    channel: "dev",
    sourceCommit: commit,
    otaManifest: {
      url: `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-builds-v3.4.0/mentra-live-ota-${id}.json`,
      sha256: "a".repeat(64),
    },
    publications: {
      "@mentra/bluetooth-sdk": {
        "npm": {coordinate: `@mentra/bluetooth-sdk@${id}`},
        "maven-central": {coordinate: `com.mentraglass:bluetooth-sdk:${id}`},
        "swift-package-manager": {coordinate: `Mentra-Community/mentra-bluetooth-sdk-ios@${id}`},
      },
      "@mentra/engine": {npm: {coordinate: `@mentra/engine@${id}`}},
    },
    ...overrides,
  }
}

function write(root, file, contents) {
  mkdirSync(path.dirname(path.join(root, file)), {recursive: true})
  writeFileSync(path.join(root, file), contents)
}

// A miniature examples/ workspace with the same SDK wiring as MentraOS.
function fixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "starter-kit-fixture-"))
  const workspace = path.join(root, "examples")
  write(
    workspace,
    "package.json",
    JSON.stringify({
      private: true,
      workspaces: [
        "oem-app",
        "bluetooth/react-native",
        "bluetooth/react-native-macos",
        "../mobile/modules/bluetooth-sdk",
      ],
      patchedDependencies: {"expo-modules-core@55.0.25": "patches/expo-modules-core@55.0.25.patch"},
    }),
  )
  write(workspace, "patches/expo-modules-core@55.0.25.patch", "diff --git a/x b/x\n")
  const kit = path.join(workspace, "bluetooth")
  write(kit, "README.md", "# Kit\n\nIn MentraOS this builds from mobile/modules/bluetooth-sdk.\n")
  write(
    kit,
    "android/settings.gradle.kts",
    [
      'rootProject.name = "Example"',
      'include(":app")',
      "",
      "// Build the Bluetooth SDK from the MentraOS source tree.",
      "// The standalone Starter Kit replaces this block with the published version.",
      'includeBuild("../../../mobile/modules/bluetooth-sdk/android") {',
      "    dependencySubstitution {",
      '        substitute(module("com.mentraglass:bluetooth-sdk")).using(project(":"))',
      "    }",
      "}",
      "",
    ].join("\n"),
  )
  write(kit, "android/gradle.properties", "android.useAndroidX=true\n")
  write(kit, "android/app/build.gradle.kts", 'dependencies {\n    implementation("com.mentraglass:bluetooth-sdk")\n}\n')
  write(
    kit,
    "ios/project.yml",
    "packages:\n  MentraBluetoothSDK:\n    path: ../../../mobile/modules/bluetooth-sdk\n\ntargets: {}\n",
  )
  write(
    kit,
    "ios/MentraExample.xcodeproj/project.pbxproj",
    [
      "\t\t\tpackageReferences = (",
      '\t\t\t\t1178B517C2B84A06A3850002 /* XCLocalSwiftPackageReference "../../../mobile/modules/bluetooth-sdk" */,',
      "\t\t\t);",
      "/* Begin XCLocalSwiftPackageReference section */",
      '\t\t1178B517C2B84A06A3850002 /* XCLocalSwiftPackageReference "../../../mobile/modules/bluetooth-sdk" */ = {',
      "\t\t\tisa = XCLocalSwiftPackageReference;",
      "\t\t\trelativePath = ../../../mobile/modules/bluetooth-sdk;",
      "\t\t};",
      "/* End XCLocalSwiftPackageReference section */",
      "",
      "/* Begin XCSwiftPackageProductDependency section */",
      "\t\t1178B517C2B84A06A3850003 /* MentraBluetoothSDK */ = {",
      "\t\t\tisa = XCSwiftPackageProductDependency;",
      '\t\t\tpackage = 1178B517C2B84A06A3850002 /* XCLocalSwiftPackageReference "../../../mobile/modules/bluetooth-sdk" */;',
      "\t\t\tproductName = MentraBluetoothSDK;",
      "\t\t};",
      "",
    ].join("\n"),
  )
  write(
    kit,
    "macos/Package.swift",
    [
      "// swift-tools-version: 5.9",
      "import PackageDescription",
      "",
      "// Builds against the Bluetooth SDK source in this MentraOS checkout. The",
      "// standalone Starter Kit pins the published SwiftPM package instead.",
      "let package = Package(",
      '    name: "MentraMacExample",',
      "    dependencies: [",
      '        .package(name: "MentraBluetoothSDK", path: "../../../mobile/modules/bluetooth-sdk"),',
      "    ],",
      '    targets: [.executableTarget(name: "MentraMacExample", dependencies: [',
      '        .product(name: "MentraBluetoothSDK", package: "MentraBluetoothSDK"),',
      "    ])]",
      ")",
      "",
    ].join("\n"),
  )
  write(
    kit,
    "react-native/package.json",
    JSON.stringify({
      name: "rn",
      dependencies: {
        "@mentra/bluetooth-sdk": "workspace:*",
        "@mentra/engine": "workspace:*",
        "@mentra/local-module": "file:modules/local-module",
        "expo": "~55.0.24",
      },
    }),
  )
  write(kit, "react-native/metro.config.js", "module.exports = {}\n")
  write(kit, "react-native/node_modules/ignored/package.json", "{}")
  write(
    kit,
    "react-native-macos/package.json",
    JSON.stringify({name: "rn-macos", dependencies: {"@mentra/bluetooth-sdk": "workspace:*", "expo": "~55.0.24"}}),
  )
  return {root, workspace, kit}
}

test("release records live in the channel's release container", () => {
  assert.equal(releaseContainer("3.4.0-dev.1040"), "mentra-builds-v3.4.0")
  assert.equal(releaseContainer("3.3.0"), "mentra-v3.3.0")
  assert.equal(
    releaseRecordUrl("3.3.0-beta.7"),
    "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-builds-v3.3.0/mentra-release-3.3.0-beta.7.json",
  )
})

test("the export pins exactly the coordinates the completed release published", () => {
  const coordinates = exportCoordinates(releaseRecord(), {channel: "dev", identity})
  assert.equal(coordinates.branch, "dev")
  assert.deepEqual(coordinates.npm, {"@mentra/bluetooth-sdk": identity, "@mentra/engine": identity})
  assert.deepEqual(coordinates.maven, [
    `com.mentraglass:bluetooth-sdk:${identity}`,
    `com.mentraglass:lc3Lib:${identity}`,
  ])
  assert.equal(coordinates.swiftPackage.url, "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git")
  assert.equal(exportCoordinates(releaseRecord({releaseIdentity: "3.3.0-beta.7", channel: "beta"})).branch, "staging")
  assert.equal(exportCoordinates(releaseRecord({releaseIdentity: "3.3.0", channel: "production"})).branch, "main")

  assert.throws(() => exportCoordinates(releaseRecord(), {channel: "beta"}), /channel/)
  assert.throws(() => exportCoordinates(releaseRecord(), {identity: "3.4.0-dev.1"}), /describes/)
  const stale = releaseRecord()
  stale.publications["@mentra/engine"].npm.coordinate = "@mentra/engine@3.4.0-dev.1039"
  assert.throws(() => exportCoordinates(stale), /npm Engine/)
  const incomplete = releaseRecord()
  delete incomplete.publications["@mentra/bluetooth-sdk"]["maven-central"]
  assert.throws(() => exportCoordinates(incomplete), /Maven/)
  assert.throws(() => exportCoordinates({...releaseRecord(), otaManifest: undefined}), /OTA manifest/)
})

test("a fixture example tree becomes a standalone kit with no source references", () => {
  const {root, workspace, kit} = fixtureWorkspace()
  const out = path.join(root, "export")
  try {
    assert.ok(sourceReferences(kit).length > 0, "the fixture starts out wired to the source tree")
    const record = releaseRecord()
    const {examples} = transformStarterKit({
      examplesDir: kit,
      workspaceDir: workspace,
      outDir: out,
      record,
      recordSha256: "b".repeat(64),
    })
    assert.deepEqual(examples, ["examples/react-native", "examples/react-native-macos"])
    guardStarterKit(out)

    const read = (file) => readFileSync(path.join(out, file), "utf8")
    assert.doesNotMatch(read("examples/android/settings.gradle.kts"), /includeBuild|MentraOS source tree/)
    assert.match(read("examples/android/settings.gradle.kts"), /include\(":app"\)\n$/)
    assert.match(read("examples/android/app/build.gradle.kts"), /bluetooth-sdk:\$\{property\("mentraSdkVersion"\)\}/)
    assert.equal(read("examples/android/gradle.properties"), `android.useAndroidX=true\nmentraSdkVersion=${identity}\n`)
    assert.match(
      read("examples/ios/project.yml"),
      new RegExp(
        `url: https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git\\n    exactVersion: ${identity.replaceAll(".", "\\.")}`,
      ),
    )
    const project = read("examples/ios/MentraExample.xcodeproj/project.pbxproj")
    assert.doesNotMatch(project, /XCLocalSwiftPackageReference|relativePath/)
    assert.equal([...project.matchAll(/XCRemoteSwiftPackageReference "mentra-bluetooth-sdk-ios"/g)].length, 3)
    assert.match(
      project,
      /isa = XCRemoteSwiftPackageReference;\n\t\t\trepositoryURL = "https:\/\/github\.com\/Mentra-Community\/mentra-bluetooth-sdk-ios\.git";/,
    )
    assert.match(
      project,
      new RegExp(`kind = exactVersion;\\n\\t\\t\\t\\tversion = ${identity.replaceAll(".", "\\.")};`),
    )
    const swift = read("examples/macos/Package.swift")
    assert.match(swift, new RegExp(`let sdkVersion = "${identity.replaceAll(".", "\\.")}"`))
    assert.match(
      swift,
      /\.package\(url: "https:\/\/github\.com\/Mentra-Community\/mentra-bluetooth-sdk-ios\.git", exact: Version\(sdkVersion\)!\)/,
    )
    assert.match(swift, /package: "mentra-bluetooth-sdk-ios"\)/)

    const app = JSON.parse(read("examples/react-native/package.json"))
    assert.equal(app.dependencies["@mentra/bluetooth-sdk"], identity)
    assert.equal(app.dependencies["@mentra/engine"], identity)
    assert.equal(app.dependencies["@mentra/local-module"], "file:modules/local-module")
    assert.deepEqual(app.patchedDependencies, {"expo-modules-core@55.0.25": "patches/expo-modules-core@55.0.25.patch"})
    assert.equal(read("examples/react-native-macos/patches/expo-modules-core@55.0.25.patch"), "diff --git a/x b/x\n")
    assert.equal(read("README.md"), "# Kit\n\nIn MentraOS this builds from mobile/modules/bluetooth-sdk.\n")
    assert.throws(() => read("examples/react-native/node_modules/ignored/package.json"), /ENOENT/)

    const kitRecord = JSON.parse(read("starter-kit-release.json"))
    assert.equal(kitRecord.releaseIdentity, identity)
    assert.equal(kitRecord.sourceCommit, commit)
    assert.deepEqual(kitRecord.releaseRecord, {url: releaseRecordUrl(identity), sha256: "b".repeat(64)})
    assert.deepEqual(kitRecord.otaManifest, record.otaManifest)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test("the guard rejects any build file that still reaches into MentraOS", () => {
  const {root, workspace, kit} = fixtureWorkspace()
  const out = path.join(root, "export")
  try {
    transformStarterKit({
      examplesDir: kit,
      workspaceDir: workspace,
      outDir: out,
      record: releaseRecord(),
      recordSha256: "b".repeat(64),
    })
    for (const [file, contents, message] of [
      [
        "examples/react-native/package.json",
        '{"dependencies": {"@mentra/crust": "workspace:*"}}',
        /workspace: dependency/,
      ],
      [
        "examples/react-native/bun.lock",
        '"@mentra/engine": ["@mentra/engine@workspace:../mobile/modules/engine"]',
        /workspace/,
      ],
      ["examples/macos/Package.swift", '.package(path: "../../../mobile/modules/bluetooth-sdk")', /Swift package/],
      ["examples/android/settings.gradle.kts", 'includeBuild("../sdk")', /composite build/],
      [
        "examples/react-native-macos/package.json",
        '{"dependencies": {"x": "file:../../../cloud-v2/packages/protocol"}}',
        /outside the example|MentraOS/,
      ],
    ]) {
      const target = path.join(out, file)
      let original = ""
      try {
        original = readFileSync(target, "utf8")
      } catch {}
      writeFileSync(target, contents)
      assert.throws(() => guardStarterKit(out), message, file)
      writeFileSync(target, original)
    }
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test("a rewrite that no longer matches the source fails the export", () => {
  const {root, workspace, kit} = fixtureWorkspace()
  try {
    writeFileSync(path.join(kit, "ios/project.yml"), "packages: {}\n")
    assert.throws(
      () =>
        transformStarterKit({
          examplesDir: kit,
          workspaceDir: workspace,
          outDir: path.join(root, "export"),
          record: releaseRecord(),
          recordSha256: "b".repeat(64),
        }),
      /Expected exactly one local MentraBluetoothSDK package in project\.yml, found 0/,
    )
    assert.throws(
      () =>
        transformStarterKit({
          examplesDir: kit,
          workspaceDir: workspace,
          outDir: path.join(kit, "export"),
          record: releaseRecord(),
          recordSha256: "b".repeat(64),
        }),
      /outside the source tree/,
    )
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test("a patch must still resolve in the standalone lockfile", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "starter-kit-lock-"))
  try {
    write(
      directory,
      "package.json",
      JSON.stringify({patchedDependencies: {"expo-modules-core@55.0.25": "patches/p.patch"}}),
    )
    write(directory, "bun.lock", '"expo-modules-core": ["expo-modules-core@55.0.25", ""]')
    verifyPatchedLockfile(directory)
    write(directory, "bun.lock", '"expo-modules-core": ["expo-modules-core@55.0.27", ""]')
    assert.throws(() => verifyPatchedLockfile(directory), /resolves another version/)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test("the MentraOS examples tree exports to a standalone kit", () => {
  const out = mkdtempSync(path.join(tmpdir(), "starter-kit-export-"))
  try {
    const {examples} = transformStarterKit({
      examplesDir: path.join(repositoryRoot, "examples/bluetooth"),
      outDir: path.join(out, "kit"),
      record: releaseRecord(),
      recordSha256: "b".repeat(64),
    })
    assert.deepEqual(examples.sort(), [
      "examples/react-native",
      "examples/react-native-elevenlabs-audio",
      "examples/react-native-macos",
    ])
    // Lockfiles are written by the export workflow; everything else is final.
    assert.deepEqual(sourceReferences(path.join(out, "kit")), [])
    // The kit keeps its own CI in its repository; the export never carries one.
    assert.equal(existsSync(path.join(out, "kit/.github")), false)
  } finally {
    rmSync(out, {recursive: true, force: true})
  }
})

test("a production release record pins the plain versions it promoted", () => {
  const record = {
    schemaVersion: 1,
    kind: "mentra-production-release",
    releaseIdentity: "3.3.0",
    channel: "production",
    sourceCommit: commit,
    releaseFamily: {
      members: {
        "@mentra/bluetooth-sdk": {version: "3.3.0", publishTargets: ["npm", "maven-central", "swift-package-manager"]},
        "@mentra/engine": {version: "3.3.0", publishTargets: ["npm"]},
      },
    },
    otaManifest: {
      url: "https://artifactscdn.mentraglass.com/x/mentra-live-ota-3.3.0-beta.7.json",
      sha256: "d".repeat(64),
    },
  }
  const coordinates = exportCoordinates(record, {channel: "production", identity: "3.3.0"})
  assert.equal(coordinates.branch, "main")
  assert.deepEqual(coordinates.npm, {"@mentra/bluetooth-sdk": "3.3.0", "@mentra/engine": "3.3.0"})
  assert.equal(coordinates.swiftPackage.version, "3.3.0")
  assert.equal(coordinates.otaManifest.url, record.otaManifest.url)
  record.releaseFamily.members["@mentra/bluetooth-sdk"].publishTargets = ["npm"]
  assert.throws(() => exportCoordinates(record), /Maven/)
})

test("the exported kit keeps the layout the kit's own CI builds", () => {
  const ci = JSON.parse(readFileSync(new URL("fixtures/starter-kit-ci-paths.json", import.meta.url), "utf8"))
  const out = mkdtempSync(path.join(tmpdir(), "starter-kit-layout-"))
  try {
    const kit = path.join(out, "kit")
    const {examples} = transformStarterKit({
      examplesDir: path.join(repositoryRoot, "examples/bluetooth"),
      outDir: kit,
      record: releaseRecord(),
      recordSha256: "b".repeat(64),
    })
    for (const directory of ci.directories) {
      assert.ok(statSync(path.join(kit, directory)).isDirectory(), directory)
    }
    for (const file of ci.files) assert.ok(statSync(path.join(kit, file)).isFile(), file)
    // writeLockfiles writes each React Native example's lockfile where the CI installs it.
    assert.deepEqual(examples.map((example) => `${example}/bun.lock`).sort(), [...ci.lockfiles].sort())
    // Shared files stay at the root, apps sit only under examples/.
    for (const file of ["README.md", "LICENSE", ".gitignore", "docs/getting-started.md", "starter-kit-release.json"]) {
      assert.ok(existsSync(path.join(kit, file)), file)
    }
    assert.equal(existsSync(path.join(kit, "android")), false)
    assert.equal(existsSync(path.join(kit, "examples/docs")), false)
    // The values the kit's CI reads back from the pinned files.
    assert.match(
      readFileSync(path.join(kit, "examples/android/gradle.properties"), "utf8"),
      new RegExp(`^mentraSdkVersion=${identity.replaceAll(".", "\\.")}$`, "m"),
    )
    assert.match(
      readFileSync(path.join(kit, "examples/ios/MentraExample.xcodeproj/project.pbxproj"), "utf8"),
      /repositoryURL = "https:\/\/github\.com\/Mentra-Community\/mentra-bluetooth-sdk-ios\.git";/,
    )
    for (const app of ["react-native", "react-native-elevenlabs-audio"]) {
      const manifest = JSON.parse(readFileSync(path.join(kit, `examples/${app}/package.json`), "utf8"))
      assert.equal(manifest.dependencies["@mentra/bluetooth-sdk"], identity, app)
    }
    // Links and ignore patterns follow the apps into examples/.
    const readme = readFileSync(path.join(kit, "README.md"), "utf8")
    assert.match(readme, /\]\(examples\/android\/README\.md\)/)
    assert.match(readme, /\]\(docs\/getting-started\.md\)/)
    assert.match(
      readFileSync(path.join(kit, "examples/react-native/README.md"), "utf8"),
      /\]\(\.\.\/\.\.\/docs\/getting-started\.md#background-operation-on-ios\)/,
    )
    assert.match(
      readFileSync(path.join(kit, "docs/getting-started.md"), "utf8"),
      /\]\(\.\.\/examples\/react-native\/README\.md#install\)/,
    )
    const ignore = readFileSync(path.join(kit, ".gitignore"), "utf8")
    assert.match(ignore, /^examples\/android\/\.gradle\/$/m)
    assert.match(ignore, /^!examples\/ios\/$/m)
    assert.doesNotMatch(ignore, /^!?\/(android|ios|react-native)/m)
  } finally {
    rmSync(out, {recursive: true, force: true})
  }
})

test("Markdown links are rewritten for the kit layout", () => {
  const apps = ["android", "macos", "react-native", "react-native-macos"]
  assert.equal(kitLink("README.md", "android/README.md", apps), "examples/android/README.md")
  assert.equal(kitLink("README.md", "docs/api-reference.md", apps), "docs/api-reference.md")
  assert.equal(kitLink("react-native/README.md", "../docs/x.md#y", apps), "../../docs/x.md#y")
  assert.equal(kitLink("react-native-macos/README.md", "../macos/README.md", apps), "../macos/README.md")
  assert.equal(kitLink("docs/getting-started.md", "../macos/README.md", apps), "../examples/macos/README.md")
  assert.equal(
    kitLink("react-native/README.md", "../../package.json", apps),
    "https://github.com/Mentra-Community/MentraOS/blob/dev/examples/package.json",
  )
  assert.equal(kitLink("android/README.md", "./settings.gradle.kts", apps), "./settings.gradle.kts")
  assert.equal(kitLink("README.md", "https://example.com/a", apps), "https://example.com/a")
})
