import {execSync} from "child_process"
import fs from "fs"
import path from "path"

import {ConfigPlugin, withDangerousMod} from "expo/config-plugins"

/**
 * Expo Config Plugin — add the Mapbox Navigation SDK for iOS (v3) as a Swift
 * Package to the generated Xcode project so the `crust` native module can
 * `import MapboxNavigationCore`.
 *
 * Why a Swift Package and not CocoaPods: Mapbox Navigation v3 dropped reliable
 * CocoaPods support — `pod install` cannot resolve `MapboxNavigationCore`
 * (that's the "Unable to find a specification" error). v3 is SPM-first, so we
 * add it via SPM here, including its MapboxMaps dependency, and link the
 * products to the app target. The host supplies Downloads-token authentication.
 *
 * Implementation: a dangerous mod that drives the `xcodeproj` Ruby gem (always
 * present on a Mac with CocoaPods) to add the remote SPM package + product.
 * The legacy JS `xcode` pbxproj lib predates SPM and can't express package
 * references, so Ruby is the reliable path.
 *
 * Requirements at build time:
 *   • ~/.netrc with `machine api.mapbox.com / login mapbox / password sk.…`
 *     (the secret Downloads:Read token) so SPM can fetch the binaries.
 *   • Use SPM as the single Mapbox provider; do not also install MapboxMaps
 *     through CocoaPods.
 */

// Mapbox Navigation v3 resolves the matching MapboxMaps dependency through SPM.
const NAV_REPO = "https://github.com/mapbox/mapbox-navigation-ios.git"
const NAV_MIN_VERSION = "3.0.0"
// Products to link into the app target:
//   • MapboxNavigationCore — the headless engine the crust module imports.
//   • MapboxDirections      — Waypoint / RouteStep / ManeuverType / etc.
//                             (NavigationManager.swift + NavPayloads.swift use these).
//   • MapboxMaps            — peer Maps SDK / runtime-token consumer.
// Linking all three from the SAME package makes SPM the single Mapbox provider
// for the whole app.
const NAV_PRODUCTS = ["MapboxNavigationCore", "MapboxDirections", "MapboxMaps"]

/**
 * Find CocoaPods' private GEM_HOME (which contains the `xcodeproj` gem) by
 * reading it out of the `pod` launcher wrapper. Homebrew's `pod` is a bash
 * shim that does `GEM_HOME="…/libexec" exec "…/bin/pod"`. We grep that path so
 * our Ruby invocation can `require 'xcodeproj'` using the same gems CocoaPods
 * uses. Returns {} when it can't be determined (caller falls back to bare ruby).
 */
function cocoapodsGemEnv(): Record<string, string> {
  try {
    const podPath = execSync("command -v pod", {encoding: "utf8"}).trim()
    if (!podPath || !fs.existsSync(podPath)) return {}
    const contents = fs.readFileSync(podPath, "utf8")
    const m = contents.match(/GEM_HOME=["']?([^"'\s]+)["']?/)
    if (m?.[1]) return {GEM_HOME: m[1]}
  } catch {
    /* ignore — fall back to bare ruby */
  }
  return {}
}

const withMapboxNavIos: ConfigPlugin = (config) => {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot // .../ios
      const projName = cfg.modRequest.projectName // e.g. "Mentra"
      const pbxproj = path.join(iosRoot, `${projName}.xcodeproj`, "project.pbxproj")
      if (!fs.existsSync(pbxproj)) {
        throw new Error(`[mapbox-nav-ios] project.pbxproj not found at ${pbxproj}`)
      }

      // Ruby script: idempotently add the SPM remote package + product, and
      // link the product to the FIRST application target (the app, not the
      // test/extension targets).
      //
      // Written to a TEMP FILE and run as `ruby <file>` rather than inlined via
      // `ruby -e "..."` — inlining a multi-line script through the shell mangles
      // the newlines into literal backslash-n and Ruby errors with
      // "unexpected backslash". Config values are injected as JSON literals so
      // there's no string-escaping ambiguity.
      const ruby = [
        `require 'xcodeproj'`,
        `proj = Xcodeproj::Project.open(${JSON.stringify(`${projName}.xcodeproj`)})`,
        `target = proj.targets.find { |t| t.product_type == 'com.apple.product-type.application' }`,
        `abort('[mapbox-nav-ios] no application target found') unless target`,
        ``,
        `repo = ${JSON.stringify(NAV_REPO)}`,
        `products = ${JSON.stringify(NAV_PRODUCTS)}`,
        `min_version = ${JSON.stringify(NAV_MIN_VERSION)}`,
        ``,
        `# Reuse an existing package reference for this repo if present (idempotent).`,
        `pkg = proj.root_object.package_references.find { |r| r.respond_to?(:repositoryURL) && r.repositoryURL == repo }`,
        `unless pkg`,
        `  pkg = proj.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)`,
        `  pkg.repositoryURL = repo`,
        `  pkg.requirement = { 'kind' => 'upToNextMajorVersion', 'minimumVersion' => min_version }`,
        `  proj.root_object.package_references << pkg`,
        `end`,
        ``,
        `# Link each product to the target if not already linked.`,
        `products.each do |product|`,
        `  already = target.package_product_dependencies.any? { |d| d.product_name == product }`,
        `  next if already`,
        `  dep = proj.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)`,
        `  dep.package = pkg`,
        `  dep.product_name = product`,
        `  target.package_product_dependencies << dep`,
        `end`,
        ``,
        `proj.save`,
        `puts "[mapbox-nav-ios] ensured #{products.join(', ')} (>= #{min_version}) from #{repo}"`,
      ].join("\n")

      const scriptPath = path.join(iosRoot, ".mapbox-nav-ios-spm.rb")
      try {
        fs.writeFileSync(scriptPath, ruby, "utf8")
        // The `xcodeproj` gem isn't in the system Ruby — it ships INSIDE
        // CocoaPods' private GEM_HOME. Reuse CocoaPods' own environment so the
        // require works regardless of which Ruby the user has on PATH. We read
        // GEM_HOME out of the `pod` launcher wrapper (it sets it before exec),
        // falling back to a bare `ruby` (which works if the user happens to
        // have xcodeproj installed globally).
        const env = {...process.env, ...cocoapodsGemEnv()}
        execSync(`ruby ${JSON.stringify(scriptPath)}`, {
          cwd: iosRoot,
          stdio: "inherit",
          env,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(
          `[mapbox-nav-ios] failed to add the Mapbox Navigation SPM package. ` +
            `Ensure the 'xcodeproj' Ruby gem is available (it ships with CocoaPods). ` +
            `Underlying error: ${msg}`,
        )
      } finally {
        // Clean up the temp script so it doesn't linger in the generated ios/.
        try {
          fs.unlinkSync(scriptPath)
        } catch {
          /* ignore */
        }
      }

      return cfg
    },
  ])
}

export default withMapboxNavIos
