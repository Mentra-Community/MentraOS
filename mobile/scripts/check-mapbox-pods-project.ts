import {execFileSync} from "node:child_process"
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import {type ExportedConfig} from "@expo/config-plugins"

import withMapboxNavCrustLink from "../plugins/mapbox-nav-crust-link"

async function checkPodsProject() {
  const directory = mkdtempSync(path.join(tmpdir(), "mentra-mapbox-pods-"))
  try {
    const podfile = path.join(directory, "Podfile")
    writeFileSync(podfile, "post_install do |installer|\nend\n")
    const config: ExportedConfig = withMapboxNavCrustLink({name: "Test", slug: "test"})
    const mod = config.mods?.ios?.dangerous
    if (!mod) throw new Error("Mapbox plugin did not register its iOS mod")
    await mod({
      ...config,
      modRequest: {
        platform: "ios",
        modName: "dangerous",
        projectRoot: directory,
        platformProjectRoot: directory,
        introspect: false,
      },
      modResults: {},
      modRawConfig: {name: "Test", slug: "test"},
    })

    // Homebrew's pod launcher carries the gem home used by pod install.
    const pod = execFileSync("which", ["pod"], {encoding: "utf8"}).trim()
    const gemHome = readFileSync(pod, "utf8").match(/GEM_HOME=["']?([^"'\s]+)/)?.[1]
    const launcher = gemHome ? path.join(gemHome, "bin", "pod") : pod
    const ruby = readFileSync(launcher, "utf8").match(/^#!(\/[^\s]+\/ruby)\s*$/m)?.[1] ?? "ruby"
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
