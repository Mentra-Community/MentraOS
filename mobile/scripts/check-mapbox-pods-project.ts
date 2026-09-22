import {execFileSync} from "node:child_process"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {type ExportedConfig} from "@expo/config-plugins"

import withCrust from "../modules/crust/plugin/src"

async function checkPodsProject() {
  const directory = mkdtempSync(path.join(tmpdir(), "mentra-mapbox-pods-"))
  try {
    const podfile = path.join(directory, "Podfile")
    writeFileSync(podfile, "post_install do |installer|\nend\n")
    // Homebrew's pod launcher carries the gem home used by pod install.
    const pod = execFileSync("which", ["pod"], {encoding: "utf8"}).trim()
    const gemHome = readFileSync(pod, "utf8").match(/GEM_HOME=["']?([^"'\s]+)/)?.[1]
    const launcher = gemHome ? path.join(gemHome, "bin", "pod") : pod
    const ruby = readFileSync(launcher, "utf8").match(/^#!(\/[^\s]+\/ruby)\s*$/m)?.[1] ?? "ruby"
    const env = {...process.env, ...(gemHome ? {GEM_HOME: gemHome} : {})}
    execFileSync(ruby, ["-rxcodeproj", "-e", "p = Xcodeproj::Project.new(ARGV[0]); p.new_target(:application, 'Test', :ios, '15.5'); p.save", path.join(directory, "Test.xcodeproj")], {env})
    const config: ExportedConfig = withCrust({name: "Test", slug: "test"})
    const mod = config.mods?.ios?.dangerous
    if (!mod) throw new Error("Mapbox plugin did not register its iOS mod")
    await mod({
      ...config,
      modRequest: {
        platform: "ios",
        modName: "dangerous",
        projectRoot: directory,
        platformProjectRoot: directory,
        projectName: "Test",
        introspect: false,
      },
      modResults: {},
      modRawConfig: {name: "Test", slug: "test"},
    })

    execFileSync(ruby, ["-rxcodeproj", "-e", "p = Xcodeproj::Project.open(ARGV[0]); expected = %w[MapboxDirections MapboxMaps MapboxNavigationCore]; abort 'Missing app package products' unless p.targets.first.package_product_dependencies.map(&:product_name).sort == expected", path.join(directory, "Test.xcodeproj")], {env})
    const output = execFileSync(ruby, [path.join(import.meta.dir, "mapbox-pods-project.fixture.rb"), podfile], {
      encoding: "utf8",
      env: {...process.env, ...(gemHome ? {GEM_HOME: gemHome} : {})},
    })
    console.log(output.trim())
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
}

await checkPodsProject()
