import fs from "fs"
import path from "path"

import {ConfigPlugin, withDangerousMod} from "expo/config-plugins"

/**
 * Expo Config Plugin — make the Mapbox Navigation SPM modules importable from
 * the `Crust` CocoaPods target WITHOUT statically linking them into libCrust.a,
 * AND guarantee they are built BEFORE Crust compiles.
 *
 * The problem: `Crust` is a CocoaPods static-library target (in Pods.xcodeproj),
 * and the Mapbox SPM products (MapboxNavigationCore / MapboxDirections /
 * MapboxMaps) are added to the APP target in the app project (withMapboxNavIos.ts).
 * Crust's Swift needs to `import MapboxNavigationCore` etc.
 *
 * IMPORTANT — why we do NOT add package_product_dependencies to Crust:
 * adding an XCSwiftPackageProductDependency to a *static library* target makes
 * Xcode bake that product's object code straight into `libCrust.a`. The app
 * target then links `libCrust.a` (Mapbox baked in) AND the same SPM products
 * again → "duplicate symbol" link errors for every Mapbox symbol. (Confirmed:
 * MapboxNavigationCore / MapboxDirections / MapboxMaps all build as STATIC
 * swiftmodules + .o, not dynamic frameworks, so the collision is real.) A static
 * library does not need its external symbols resolved at archive time; it only
 * needs the modules to be VISIBLE at compile time so `import` typechecks. That
 * visibility is provided entirely by the search paths in Crust.podspec
 * (SWIFT_INCLUDE_PATHS / FRAMEWORK_SEARCH_PATHS / OTHER_SWIFT_FLAGS -I pointing
 * at ${PODS_CONFIGURATION_BUILD_DIR}, where SPM drops the .swiftmodule /
 * .framework). The actual Mapbox object code is linked exactly once, by the app
 * target.
 *
 * THE BUILD-ORDER RACE (why a previous version of this plugin was insufficient):
 * a clean `xcodebuild archive` builds targets in parallel against a fresh
 * ArchiveIntermediates dir. Crust only sees the Mapbox swiftmodules via search
 * paths into the shared build-products dir — but NOTHING forced those modules to
 * exist there before Crust compiled. The app target's own SPM product deps make
 * Xcode emit them, but that emission is NOT ordered relative to Crust (a target
 * in a *different* project). In practice MapboxNavigationCore.swiftmodule lands
 * in the products dir AFTER Crust compiles → `error: no such module
 * 'MapboxNavigationCore'` → ARCHIVE FAILED (exit 65), DETERMINISTICALLY on a
 * clean build. The release-ios.mjs archive-retry can't recover it: every fresh
 * clean archive re-races identically and the failed partial build never copies
 * NavigationCore's swiftmodule into the products dir for the next attempt.
 *
 * THE FIX — a build-order-only target dependency:
 *   1. Create a tiny throwaway static-library "host" target (MapboxNavOrder) in
 *      Pods.xcodeproj that carries the Mapbox SPM product dependencies. Building
 *      it forces SPM to emit MapboxNavigationCore/Directions/Maps.swiftmodule
 *      into the shared build-products dir. Its own libMapboxNavOrder.a is never
 *      linked by anyone, so the Mapbox objects baked into it are harmless (no
 *      duplicate symbols — the app still links Mapbox exactly once via its own
 *      SPM deps).
 *   2. Add a PBXTargetDependency from Crust → MapboxNavOrder. This is a pure
 *      BUILD-ORDER edge (not a link dep), so Xcode schedules the host (and thus
 *      the Mapbox swiftmodules) before Crust compiles. Verified: a clean archive
 *      now logs "Explicit dependency on target 'MapboxNavOrder'" and succeeds on
 *      the first try with no missing-module error.
 *   3. SCRUB any stale Mapbox package_product_dependencies that an older version
 *      of this plugin (or a manual edit) may have added directly to Crust, which
 *      would re-introduce the duplicate-symbol error.
 *
 * Runs as a Podfile post_install hook (not a file patch) so it executes AFTER
 * `pod install` has generated Pods.xcodeproj with the Crust target.
 */

const MARKER_BEGIN = "# @generated begin mapbox-nav-crust-link"
const MARKER_END = "# @generated end mapbox-nav-crust-link"
const PRODUCTS = ["MapboxNavigationCore", "MapboxDirections", "MapboxMaps"]
const CRUST_TARGET = "Crust"
const HOST_TARGET = "MapboxNavOrder"
// Must match the repo + version pinned in plugin/src/withMapboxNavIos.ts so the host
// target resolves the SAME package the app target uses (one Mapbox provider).
const NAV_REPO = "https://github.com/mapbox/mapbox-navigation-ios.git"
const NAV_MIN_VERSION = "3.0.0"

function crustLinkRuby(): string {
  const rubyList = PRODUCTS.map((p) => `'${p}'`).join(", ")
  return [
    `    ${MARKER_BEGIN} (DO NOT MODIFY — plugin/src/withMapboxNavCrustLink.ts)`,
    `    # Guarantee the Mapbox SPM swiftmodules are built BEFORE Crust compiles,`,
    `    # without linking them into libCrust.a (which would duplicate-symbol against`,
    `    # the app target's own copy). See plugin/src/withMapboxNavCrustLink.ts header.`,
    `    __mb_products  = [${rubyList}]`,
    `    __mb_host_name = '${HOST_TARGET}'`,
    `    __mb_repo      = '${NAV_REPO}'`,
    `    __mb_min_ver   = '${NAV_MIN_VERSION}'`,
    `    __mb_proj      = installer.pods_project`,
    `    __mb_crust     = __mb_proj.targets.find { |t| t.name == '${CRUST_TARGET}' }`,
    `    if __mb_crust.nil?`,
    `      Pod::UI.warn "[mapbox-nav-crust-link] ${CRUST_TARGET} target not found — skipping"`,
    `    else`,
    `      # CocoaPods stabilizes target UUIDs before post_install, resetting its`,
    `      # sequential allocator bookkeeping. Adding this host can then reuse`,
    `      # existing IDs, including rootObject. Use Xcodeproj's collision-checked`,
    `      # allocator for any new objects in this project after that reset.`,
    `      def __mb_proj.generate_available_uuid_list(count = 100)`,
    `        Xcodeproj::Project.instance_method(:generate_available_uuid_list).bind(self).call(count)`,
    `      end`,
    ``,
    `      # 1) SCRUB any stale Mapbox link-deps from Crust (duplicate-symbol guard).`,
    `      __removed = __mb_crust.package_product_dependencies.select { |d| __mb_products.include?(d.product_name) }`,
    `      unless __removed.empty?`,
    `        __mb_crust.package_product_dependencies.reject! { |d| __mb_products.include?(d.product_name) }`,
    `        Pod::UI.puts "[mapbox-nav-crust-link] removed stale Mapbox link-deps from ${CRUST_TARGET}: #{__removed.map(&:product_name).join(', ')}"`,
    `      end`,
    ``,
    `      # 2) Ensure a remote SPM package reference for the Nav repo exists in the`,
    `      #    Pods project (the host target's product deps point at it).`,
    `      __mb_pkg = __mb_proj.root_object.package_references.find { |r| (r.repositoryURL rescue nil) == __mb_repo }`,
    `      unless __mb_pkg`,
    `        __mb_pkg = __mb_proj.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)`,
    `        __mb_pkg.repositoryURL = __mb_repo`,
    `        __mb_pkg.requirement = { 'kind' => 'upToNextMajorVersion', 'minimumVersion' => __mb_min_ver }`,
    `        __mb_proj.root_object.package_references << __mb_pkg`,
    `      end`,
    ``,
    `      # 3) (Re)create the throwaway host static-lib target carrying the Mapbox`,
    `      #    SPM product deps. Building it emits the swiftmodules into the shared`,
    `      #    products dir; its .a is never linked, so no duplicate symbols.`,
    `      __mb_crust.dependencies.reject! { |d| d.target&.name == __mb_host_name }`,
    `      __mb_proj.targets.reject! { |t| t.name == __mb_host_name }`,
    `      __mb_host = __mb_proj.new_target(:static_library, __mb_host_name, :ios, '15.1')`,
    `      __mb_products.each do |p|`,
    `        __mb_dep = __mb_proj.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)`,
    `        __mb_dep.package = __mb_pkg`,
    `        __mb_dep.product_name = p`,
    `        __mb_host.package_product_dependencies << __mb_dep`,
    `      end`,
    ``,
    `      # 4) Build-order edge: Crust depends on the host (NOT a link dep).`,
    `      __mb_crust.add_dependency(__mb_host)`,
    `      __mb_proj.save`,
    `      Pod::UI.puts "[mapbox-nav-crust-link] ${CRUST_TARGET} now build-order-depends on #{__mb_host_name} (#{__mb_products.join(', ')})"`,
    `    end`,
    `    ${MARKER_END}`,
  ].join("\n")
}

const withMapboxNavCrustLink: ConfigPlugin = (config) => {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile")
      if (!fs.existsSync(podfilePath)) {
        throw new Error(`[mapbox-nav-crust-link] Podfile not found at ${podfilePath}`)
      }
      let contents = fs.readFileSync(podfilePath, "utf8")

      if (contents.includes(MARKER_BEGIN)) {
        const re = new RegExp(`\\n? *${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`, "g")
        contents = contents.replace(re, "\n")
      }

      const anchor = /post_install do \|installer\|\n/
      if (!anchor.test(contents)) {
        throw new Error(`[mapbox-nav-crust-link] no 'post_install do |installer|' in Podfile`)
      }
      contents = contents.replace(anchor, (m) => `${m}${crustLinkRuby()}\n`)
      fs.writeFileSync(podfilePath, contents, "utf8")
      // eslint-disable-next-line no-console
      console.log("[mapbox-nav-crust-link] injected post_install hook (build-order host target + link-dep scrub)")
      return cfg
    },
  ])
}

export default withMapboxNavCrustLink
