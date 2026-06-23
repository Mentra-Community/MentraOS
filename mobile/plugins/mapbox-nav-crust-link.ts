import fs from "fs"
import path from "path"

import {ConfigPlugin, withDangerousMod} from "@expo/config-plugins"

/**
 * Expo Config Plugin — make the Mapbox Navigation SPM modules importable from
 * the `Crust` CocoaPods target WITHOUT statically linking them into libCrust.a.
 *
 * The problem: `Crust` is a CocoaPods static-library target (in Pods.xcodeproj),
 * and the Mapbox SPM products (MapboxNavigationCore / MapboxDirections /
 * MapboxMaps) are added to the APP target in Mentra.xcodeproj (mapbox-nav-ios.ts).
 * Crust's Swift needs to `import MapboxNavigationCore` etc.
 *
 * IMPORTANT — why we do NOT add package_product_dependencies to Crust:
 * adding an XCSwiftPackageProductDependency to a *static library* target makes
 * Xcode bake that product's object code straight into `libCrust.a`. The app
 * target then links `libCrust.a` (Mapbox baked in) AND the same SPM products
 * again → "duplicate symbol" link errors for every Mapbox symbol. A static
 * library does not need its external symbols resolved at archive time; it only
 * needs the modules to be VISIBLE at compile time so `import` typechecks. That
 * visibility is provided entirely by the search paths in Crust.podspec
 * (SWIFT_INCLUDE_PATHS / FRAMEWORK_SEARCH_PATHS / OTHER_SWIFT_FLAGS -I pointing
 * at ${PODS_CONFIGURATION_BUILD_DIR}, where SPM drops the .swiftmodule /
 * .framework). The actual Mapbox object code is linked exactly once, by the app
 * target.
 *
 * So this hook's job is now to GUARANTEE BUILD ORDER (the Mapbox swiftmodules
 * must exist in the build-products dir before Crust compiles) and to REMOVE any
 * stale package_product_dependencies a previous version of this plugin added to
 * Crust (which would re-introduce the duplicate-symbol error). Build order is
 * already satisfied in practice because Pods + SPM resolve before the app
 * target's own compile, and the swiftmodules land in the shared
 * Build/Products/$CONFIG-$PLATFORM dir — so the hook only needs to scrub the
 * stale link deps.
 *
 * Runs as a Podfile post_install hook (not a file patch) so it executes AFTER
 * `pod install` has generated Pods.xcodeproj with the Crust target.
 */

const MARKER_BEGIN = "# @generated begin mapbox-nav-crust-link"
const MARKER_END = "# @generated end mapbox-nav-crust-link"
const PRODUCTS = ["MapboxNavigationCore", "MapboxDirections", "MapboxMaps"]
const CRUST_TARGET = "Crust"

function crustLinkRuby(): string {
  const rubyList = PRODUCTS.map((p) => `'${p}'`).join(", ")
  return [
    `    ${MARKER_BEGIN} (DO NOT MODIFY — plugins/mapbox-nav-crust-link.ts)`,
    `    # SCRUB any Mapbox SPM product link-deps from the Crust target. Linking`,
    `    # SPM products into a STATIC LIBRARY bakes their object code into`,
    `    # libCrust.a, which then collides with the app target's own copy of the`,
    `    # same products at the final link ("duplicate symbol"). Crust only needs`,
    `    # COMPILE-TIME visibility (provided by the search paths in Crust.podspec),`,
    `    # not a link dependency — the app target links Mapbox exactly once.`,
    `    __mb_products = [${rubyList}]`,
    `    crust = installer.pods_project.targets.find { |t| t.name == '${CRUST_TARGET}' }`,
    `    if crust`,
    `      __removed = crust.package_product_dependencies.select { |d| __mb_products.include?(d.product_name) }`,
    `      unless __removed.empty?`,
    `        crust.package_product_dependencies.reject! { |d| __mb_products.include?(d.product_name) }`,
    `        installer.pods_project.save`,
    `        Pod::UI.puts "[mapbox-nav-crust-link] removed stale Mapbox link-deps from ${CRUST_TARGET}: #{__removed.map(&:product_name).join(', ')}"`,
    `      else`,
    `        Pod::UI.puts "[mapbox-nav-crust-link] ${CRUST_TARGET} has no Mapbox link-deps (compile-time visibility via search paths) — OK"`,
    `      end`,
    `    else`,
    `      Pod::UI.warn "[mapbox-nav-crust-link] ${CRUST_TARGET} target not found in Pods project"`,
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
      console.log("[mapbox-nav-crust-link] injected post_install hook to scrub stale Mapbox link-deps from Crust")
      return cfg
    },
  ])
}

export default withMapboxNavCrustLink
