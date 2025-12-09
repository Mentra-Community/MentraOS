import {execSync} from "child_process"
import fs from "fs"
import path from "path"

import {type ConfigPlugin, withPodfile, withDangerousMod} from "expo/config-plugins"

/**
 * Add project specification after platform declaration
 */
function addProjectSpecification(podfileContent: string): string {
  // Check if already added
  if (podfileContent.includes("project 'MentraOS.xcodeproj'")) {
    return podfileContent
  }
  // Find platform declaration and add project specification after it
  const platformRegex = /(platform :ios[^\n]+\n)/
  const match = podfileContent.match(platformRegex)
  if (match) {
    const projectSpec = `\n# Specify which Xcode project to use\nproject 'MentraOS.xcodeproj'\n`
    return podfileContent.replace(platformRegex, `$1${projectSpec}`)
  }
  return podfileContent
}

/**
 * Add pod dependencies for onnxruntime-objc and SWCompression
 */
function addPodDependencies(podfileContent: string): string {
  // Check if already added
  if (podfileContent.includes("pod 'onnxruntime-objc'")) {
    return podfileContent
  }
  // Find the config = use_native_modules! line and add pods before use_frameworks!
  const nativeModulesRegex = /(config = use_native_modules!\([^)]+\)\n)/
  const match = podfileContent.match(nativeModulesRegex)
  if (match) {
    const podDependencies = `
    # Add SWCompression for TarBz2Extractor functionality
    pod 'onnxruntime-objc', '1.18.0', :modular_headers => true
    pod 'SWCompression', '~> 4.8.0'
  `
    return podfileContent.replace(nativeModulesRegex, `$1${podDependencies}\n`)
  }
  return podfileContent
}

/**
 * Add post_install configuration to exclude PrivacyInfo.xcprivacy files
 */
function addPostInstallConfiguration(podfileContent: string): string {
  // Check if privacy exclusion is already added
  if (podfileContent.includes("EXCLUDED_SOURCE_FILE_NAMES")) {
    return podfileContent
  }
  // Find the post_install block and add the configuration before the closing 'end'
  const postInstallRegex =
    /(post_install do \|installer\|[\s\S]*?react_native_post_install\([^)]*\)[\s\S]*?\))([\s\S]*?)(end[\s]*end)/
  const match = podfileContent.match(postInstallRegex)
  if (match) {
    const privacyExclusion = `
      installer.pods_project.targets.each do |target|
          target.build_configurations.each do |config|
          config.build_settings['EXCLUDED_SOURCE_FILE_NAMES'] = 'PrivacyInfo.xcprivacy'
          end
      end`
    return podfileContent.replace(postInstallRegex, `$1${privacyExclusion}\n  $3`)
  }
  return podfileContent
}

const modifyPodfile: ConfigPlugin = config => {
  return withPodfile(config, config => {
    const podfileContent = config.modResults.contents
    // Apply all Podfile modifications
    let modifiedContent = podfileContent
    // 1. Add project specification after platform declaration
    modifiedContent = addProjectSpecification(modifiedContent)
    // 2. Add pod dependencies in the target block
    modifiedContent = addPodDependencies(modifiedContent)
    // 3. Add post_install configuration
    modifiedContent = addPostInstallConfiguration(modifiedContent)
    config.modResults.contents = modifiedContent
    return config
  })
}

const withXcodeEnvLocal: ConfigPlugin = config => {
  return withDangerousMod(config, [
    "ios",
    async config => {
      try {
        // Get node executable path
        const nodeExecutable = execSync("which node", {encoding: "utf-8"}).trim()

        // Path to .xcode.env.local
        const iosPath = path.join(config.modRequest.platformProjectRoot)
        const xcodeEnvLocalPath = path.join(iosPath, ".xcode.env.local")

        // Content to write
        const content = `export NODE_BINARY=${nodeExecutable}\n`

        // Write or append to .xcode.env.local
        if (fs.existsSync(xcodeEnvLocalPath)) {
          const existingContent = fs.readFileSync(xcodeEnvLocalPath, "utf-8")
          if (!existingContent.includes("NODE_BINARY")) {
            fs.appendFileSync(xcodeEnvLocalPath, content)
          }
        } else {
          fs.writeFileSync(xcodeEnvLocalPath, content)
        }
      } catch (error) {
        console.warn("Failed to create .xcode.env.local:", error)
      }

      return config
    },
  ])
}

export const withIosConfiguration: ConfigPlugin<{node?: boolean}> = (config, props) => {
  config = modifyPodfile(config)
  if (props?.node) {
    config = withXcodeEnvLocal(config)
  }
  return config
}
