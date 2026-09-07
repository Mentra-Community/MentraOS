import fs from "fs"
import path from "path"

import {ConfigPlugin, withDangerousMod} from "@expo/config-plugins"

/**
 * Xcode 26 rejects IPHONEOS_DEPLOYMENT_TARGET below 12.0. Several CocoaPods
 * (SWCompression, Sentry, BitByteData, …) still ship resource-bundle targets
 * pinned to 11.0, which floods `xcodebuild` with:
 *
 *   The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
 *   but the range of supported deployment target versions is 12.0 to 26.5.99.
 *
 * expo-build-properties only lifts the app target + `platform :ios`. This hook
 * floors every Pods target after `pod install` generates them.
 *
 * AzureCommunicationCalling's prebuilt xcframework was compiled for iOS 12.0.
 * If AzureCommunicationCommon is built at the app's 15.1 floor, Swift cannot
 * rebuild Calling's .swiftinterface and reports a bogus compiler-version
 * mismatch. Microsoft requires both ACS pods stay on 12.0.
 *
 * This block must run AFTER react_native_post_install — RN lifts every pod to
 * the Podfile platform (15.1) and would otherwise overwrite the ACS 12.0 pin.
 */

const MARKER_BEGIN = "# @generated begin ios-pod-min-deployment-target"
const MARKER_END = "# @generated end ios-pod-min-deployment-target"
const MIN_DEPLOYMENT_TARGET = "12.0"

function minDeploymentTargetRuby(): string {
  return [
    `    ${MARKER_BEGIN} (DO NOT MODIFY — plugins/ios-pod-min-deployment-target.ts)`,
    `    acs_ios12 = ['AzureCommunicationCalling', 'AzureCommunicationCommon']`,
    `    installer.pods_project.targets.each do |target|`,
    `      target.build_configurations.each do |config|`,
    `        if acs_ios12.include?(target.name)`,
    `          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_DEPLOYMENT_TARGET}'`,
    `          if target.name == 'AzureCommunicationCommon'`,
    `            config.build_settings['DYLIB_INSTALL_NAME_BASE'] = '@rpath'`,
    `          end`,
    `        else`,
    `          current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']`,
    `          if current.nil? || current.to_f < ${MIN_DEPLOYMENT_TARGET}`,
    `            config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_DEPLOYMENT_TARGET}'`,
    `          end`,
    `        end`,
    `      end`,
    `    end`,
    `    ${MARKER_END}`,
  ].join("\n")
}

const withIosPodMinDeploymentTarget: ConfigPlugin = (config) => {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile")
      if (!fs.existsSync(podfilePath)) {
        throw new Error(`[ios-pod-min-deployment-target] Podfile not found at ${podfilePath}`)
      }
      let contents = fs.readFileSync(podfilePath, "utf8")

      if (contents.includes(MARKER_BEGIN)) {
        const re = new RegExp(`\\n? *${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`, "g")
        contents = contents.replace(re, "\n")
      }

      const anchor = /react_native_post_install\(\n(?:[ \t]*.*\n)*?[ \t]*\)\n/
      if (!anchor.test(contents)) {
        throw new Error(`[ios-pod-min-deployment-target] no react_native_post_install(...) in Podfile`)
      }
      contents = contents.replace(anchor, (m) => `${m}${minDeploymentTargetRuby()}\n`)
      fs.writeFileSync(podfilePath, contents, "utf8")
      return cfg
    },
  ])
}

export default withIosPodMinDeploymentTarget
