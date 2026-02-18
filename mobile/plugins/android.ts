import {execSync} from "child_process"
import fs from "fs"
import path from "path"

import {
  ConfigPlugin,
  withAppBuildGradle,
  // withSettingsGradle,
  withGradleProperties,
  withAndroidManifest,
} from "@expo/config-plugins"

/**
 * Expo Config Plugin to apply android-working modifications
 * This ensures that after running expo prebuild, all custom Android configurations are preserved
 */
const withAndroidWorkingConfig: ConfigPlugin = (config) => {
  // Apply all modifications in sequence
  config = withAppBuildGradleModifications(config)
  config = withAndroidManifestModifications(config)
  config = withXmlResourceFiles(config)
  config = withGradlePropertiesModifications(config)
  // config = withSettingsGradleModifications(config)

  return config
}

/**
 * Modify app/build.gradle to add custom configurations
 */
function withAppBuildGradleModifications(config: any) {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents

    // 1. Add release credentials and conditional Sentry script (after jscFlavor)
    if (!buildGradle.includes("releaseStorePassword =")) {
      const credentialsAndSentry = `
/**
 * Release-Store credentials.
 * Looks for keystore in shared location (~/.mentra/credentials/) first,
 * then falls back to repo-local credentials/ folder.
 * If no keystore is found, falls back to debug keystore for local development.
 */
def releaseStorePassword = project.hasProperty("MENTRAOS_UPLOAD_STORE_PASSWORD") ? project.property("MENTRAOS_UPLOAD_STORE_PASSWORD") : ""
def releaseKeyPassword = project.hasProperty("MENTRAOS_UPLOAD_KEY_PASSWORD") ? project.property("MENTRAOS_UPLOAD_KEY_PASSWORD") : ""
def releaseKeyAlias = project.hasProperty("MENTRAOS_UPLOAD_KEY_ALIAS") ? project.property("MENTRAOS_UPLOAD_KEY_ALIAS") : "upload"

// Find keystore: check shared location first, then local
def sharedKeystore = new File(System.getProperty("user.home"), ".mentra/credentials/upload-keystore.jks")
def localKeystore = file('../../credentials/upload-keystore.jks')
def releaseKeystoreFile = sharedKeystore.exists() ? sharedKeystore : (localKeystore.exists() ? localKeystore : null)

// Check if we have valid release signing credentials
def hasReleaseSigningConfig = releaseKeystoreFile != null && releaseStorePassword

// Print signing configuration being used
println ""
println "=============================================="
println "[MentraOS] Signing Configuration"
println "=============================================="
if (hasReleaseSigningConfig) {
    println "  Using RELEASE keystore: \${releaseKeystoreFile.absolutePath}"
    println "  Key alias: \${releaseKeyAlias}"
} else {
    println "  Using DEBUG keystore (no release credentials found)"
    println "  Checked locations:"
    println "    - \${sharedKeystore.absolutePath} (\${sharedKeystore.exists() ? 'exists' : 'not found'})"
    println "    - \${localKeystore.absolutePath} (\${localKeystore.exists() ? 'exists' : 'not found'})"
    if (releaseKeystoreFile != null && !releaseStorePassword) {
        println "  NOTE: Keystore found but MENTRAOS_UPLOAD_STORE_PASSWORD not set"
    }
    println ""
    println "  Release builds will be signed with debug key (NOT for production!)"
}
println "=============================================="
println ""

// Conditionally apply Sentry gradle script for source map uploads
if (project.hasProperty("sentryUploadEnabled") && project.property("sentryUploadEnabled").toBoolean()) {
    apply from: new File(["node", "--print", "require('path').dirname(require.resolve('@sentry/react-native/package.json'))"].execute().text.trim(), "sentry.gradle")
}
`

      buildGradle = buildGradle.replace(
        /def jscFlavor = ['"]io\.github\.react-native-community:jsc-android:[^'"]*['"]/,
        (match) => `${match}\n${credentialsAndSentry}`,
      )
    }

    // 2. Update versionName to 2.5.0
    buildGradle = buildGradle.replace(/versionName\s+["'][^"']*["']/, 'versionName "2.5.0"')

    // 3. Add externalNativeBuild configuration in defaultConfig
    if (!buildGradle.includes("externalNativeBuild")) {
      buildGradle = buildGradle.replace(
        /(buildConfigField\s+"String",\s+"REACT_NATIVE_RELEASE_LEVEL"[^}]+)/,
        `$1

        externalNativeBuild {
            cmake {
                arguments "-DANDROID_STL=c++_shared",
                          "-DCMAKE_CXX_STANDARD=20"
                cppFlags "-std=c++20"
            }
        }`,
      )
    }

    // 4. Add additional packagingOptions
    if (!buildGradle.includes("pickFirst '**/libjsc.so'")) {
      buildGradle = buildGradle.replace(
        /(packagingOptions\s*{[^}]*jniLibs\s*{[^}]*})/,
        `$1

        pickFirst '**/libjsc.so'
        pickFirst '**/libc++_shared.so'
        pickFirst '**/libonnxruntime.so'
        pickFirst '**/libonnxruntime4j_jni.so'

        resources {
            excludes += ["META-INF/INDEX.LIST"]
        }`,
      )
    }

    // 6. Add release signing config with fallback to debug keystore (from android-signing-config.js)
    if (!buildGradle.includes("storeFile releaseKeystoreFile")) {
      const releaseSigningConfig = `
        release {
            if (hasReleaseSigningConfig) {
                storeFile releaseKeystoreFile
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            } else {
                // Fall back to debug keystore for local development
                storeFile file('debug.keystore')
                storePassword 'android'
                keyAlias 'androiddebugkey'
                keyPassword 'android'
            }
        }`

      buildGradle = buildGradle.replace(/(signingConfigs\s*{\s*debug\s*{[^}]*})/, `$1${releaseSigningConfig}`)
    }

    // 7. Update release build type to always use release signing config (which has fallback built-in)
    if (
      buildGradle.includes("signingConfig signingConfigs.debug") &&
      buildGradle.includes("release {") &&
      !buildGradle.includes("signingConfig signingConfigs.release")
    ) {
      buildGradle = buildGradle.replace(
        /release\s*{[^{}]*signingConfig signingConfigs\.debug/,
        "release {\n            // signingConfigs.release has built-in fallback to debug keystore\n            signingConfig signingConfigs.release",
      )
    }

    config.modResults.contents = buildGradle
    return config
  })
}

/**
 * Modify AndroidManifest.xml to add additional permissions and configurations
 */
function withAndroidManifestModifications(config: any) {
  return withAndroidManifest(config, (config) => {
    const manifest: any = config.modResults.manifest

    // Remove permissions that Google Play doesn't allow for our use case
    // We only SAVE photos from glasses - we don't need to READ the user's photo library
    // expo-media-library adds these automatically, but we must remove them for Play Store compliance
    // Google's Photo and Video Permissions policy requires apps to use Photo Picker for one-time access
    // Android 10+ (API 29+) doesn't need any permission to save to MediaStore via ContentResolver
    const permissionsToRemove = [
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.WRITE_MEDIA_VIDEO", // Not needed - MediaStore API works without it on API 29+
      "android.permission.ACCESS_MEDIA_LOCATION", // Not needed - we save photos, don't read EXIF from user's library
    ]

    // Filter out permissions we want to remove
    if (manifest["uses-permission"]) {
      manifest["uses-permission"] = manifest["uses-permission"].filter(
        (p: any) => !permissionsToRemove.includes(p.$["android:name"]),
      )
    }

    // Add permissions that need to be added
    const permissionsToAdd = [
      {name: "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"},
      {name: "android.permission.BLUETOOTH", maxSdkVersion: 30},
      {name: "android.permission.BLUETOOTH_ADMIN", maxSdkVersion: 30},
      {name: "android.permission.BLUETOOTH_ADVERTISE"},
      {name: "android.permission.BLUETOOTH_CONNECT"},
      {name: "android.permission.BLUETOOTH_SCAN"},
      {name: "android.permission.FOREGROUND_SERVICE"},
      {name: "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"},
      {name: "android.permission.FOREGROUND_SERVICE_DATA_SYNC"},
      {name: "android.permission.FOREGROUND_SERVICE_LOCATION"},
      {name: "android.permission.FOREGROUND_SERVICE_MICROPHONE"},
      {name: "android.permission.NEARBY_DEVICES"},
      {name: "android.permission.POST_NOTIFICATIONS"},
      {name: "android.permission.QUERY_ALL_PACKAGES"},
      {name: "android.permission.READ_PHONE_STATE"},
      {name: "android.permission.RECEIVE_BOOT_COMPLETED"},
      {name: "com.mentra.mentra.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"},
    ]

    // Ensure uses-permission array exists
    if (!manifest["uses-permission"]) {
      manifest["uses-permission"] = []
    }

    // Add each permission if it doesn't exist
    permissionsToAdd.forEach((perm) => {
      const existingPerm = manifest["uses-permission"].find((p: any) => p.$["android:name"] === perm.name)

      if (!existingPerm) {
        const permissionObj: any = {
          $: {"android:name": perm.name},
        }

        if (perm.maxSdkVersion) {
          permissionObj.$["android:maxSdkVersion"] = perm.maxSdkVersion.toString()
        }

        manifest["uses-permission"].push(permissionObj)
      }
    })

    const versionsThatNeedUpdates = [
      {name: "android.permission.READ_EXTERNAL_STORAGE", maxSdkVersion: "32"},
      {name: "android.permission.WRITE_EXTERNAL_STORAGE", maxSdkVersion: "29"},
      {name: "android.permission.BLUETOOTH", maxSdkVersion: "30"},
    ]

    versionsThatNeedUpdates.forEach((version: any) => {
      const permission = manifest["uses-permission"].find((p: any) => p.$["android:name"] === version.name)
      if (permission && !permission.$["android:maxSdkVersion"]) {
        permission.$["android:maxSdkVersion"] = version.maxSdkVersion
      }
    })

    // Add custom permission declaration
    if (!manifest.permission) {
      manifest.permission = []
    }
    const customPermExists = manifest.permission.find(
      (p: any) => p.$["android:name"] === "com.mentra.mentra.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
    )
    if (!customPermExists) {
      manifest.permission.push({
        $: {
          "android:name": "com.mentra.mentra.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
        },
      })
    }

    // Add networkSecurityConfig and enableOnBackInvokedCallback to application tag
    const app = manifest.application?.[0]
    if (app) {
      if (!app.$["android:networkSecurityConfig"]) {
        app.$["android:networkSecurityConfig"] = "@xml/network_security_config"
      }
      if (!app.$["android:enableOnBackInvokedCallback"]) {
        app.$["android:enableOnBackInvokedCallback"] = "true"
      }
    }

    // Add additional scheme to MainActivity intent-filter
    const mainActivity = app?.activity?.find((a: any) => a.$["android:name"] === ".MainActivity")
    if (mainActivity && mainActivity["intent-filter"]) {
      // Find the intent-filter with com.mentra scheme
      const schemeFilter = mainActivity["intent-filter"].find((filter: any) => {
        return filter.data?.some((d: any) => d.$["android:scheme"] === "com.mentra")
      })

      if (schemeFilter && schemeFilter.data) {
        const hasExtraScheme = schemeFilter.data.some((d: any) => d.$["android:scheme"] === "com.mentra.mentra")

        if (!hasExtraScheme) {
          schemeFilter.data.push({
            $: {"android:scheme": "com.mentra.mentra"},
          })
        }
      }
    }

    return config
  })
}

/**
 * Create XML resource files (file_paths.xml and network_security_config.xml)
 * Uses dangerous mod to directly write files to the filesystem
 */
function withXmlResourceFiles(config: any) {
  return withAndroidManifest(config, (config) => {
    const projectRoot = config.modRequest.projectRoot
    const androidResPath = path.join(projectRoot, "android", "app", "src", "main", "res", "xml")

    // Ensure xml directory exists
    if (!fs.existsSync(androidResPath)) {
      fs.mkdirSync(androidResPath, {recursive: true})
    }

    // Write file_paths.xml
    const filePathsXml = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- Internal storage files directory -->
    <files-path
        name="internal_files"
        path="." />

    <!-- ASGPhotos directory specifically -->
    <files-path
        name="asg_photos"
        path="ASGPhotos/" />

    <!-- STT Model directory -->
    <files-path
        name="stt_models"
        path="stt_models/" />

    <!-- AugmentOSRecordings directory for videos -->
    <external-path
        name="augmentos_recordings"
        path="AugmentOSRecordings/" />

    <!-- External storage -->
    <external-files-path
        name="external_files"
        path="." />

    <!-- Cache directory -->
    <cache-path
        name="cache"
        path="." />

    <!-- External cache -->
    <external-cache-path
        name="external_cache"
        path="." />
</paths>`

    fs.writeFileSync(path.join(androidResPath, "file_paths.xml"), filePathsXml)

    // Write network_security_config.xml
    const networkSecurityConfigXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Allow cleartext traffic (HTTP) for all connections -->
    <!-- Safe because we only connect to local glasses and our own servers -->
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>`

    fs.writeFileSync(path.join(androidResPath, "network_security_config.xml"), networkSecurityConfigXml)

    return config
  })
}

/**
 * Modify gradle.properties to add Sentry configuration and node path
 */
function withGradlePropertiesModifications(config: any) {
  return withGradleProperties(config, (config) => {
    let props = config.modResults

    // Add Sentry configuration if not present
    if (!props.find((p) => p.type === "property" && p.key === "sentryUploadEnabled")) {
      props.push({
        type: "comment",
        value: " Sentry configuration",
      })
      props.push({
        type: "comment",
        value: " Set to false to disable Sentry source map uploads (useful for local builds)",
      })
      props.push({
        type: "property",
        key: "sentryUploadEnabled",
        value: "false",
      })
    }

    // Get node path and add to org.gradle.jvmargs
    try {
      const nodeExecutable = execSync("which node", {encoding: "utf-8"}).trim()
      // Get parent directory of bin (e.g., /path/to/node/bin/node -> /path/to/node)
      const nodePath = path.dirname(nodeExecutable)

      // Find existing org.gradle.jvmargs property
      const jvmArgsIndex = props.findIndex((p) => p.type === "property" && p.key === "org.gradle.jvmargs")

      if (jvmArgsIndex !== -1) {
        // Append nodePath to existing jvmargs if not already present
        const jvmArgsProp = props[jvmArgsIndex]
        if (jvmArgsProp.type === "property" && "value" in jvmArgsProp) {
          const currentValue = jvmArgsProp.value
          if (!currentValue.includes("-Dorg.gradle.project.nodePath=")) {
            jvmArgsProp.value = `${currentValue} -Dorg.gradle.project.nodePath=${nodePath}`
          }
        }
      } else {
        // Create new jvmargs property with nodePath
        props.push({
          type: "property",
          key: "org.gradle.jvmargs",
          value: `-Dorg.gradle.project.nodePath=${nodePath}`,
        })
      }
    } catch (error) {
      console.warn("Failed to get node path:", error)
    }

    config.modResults = props
    return config
  })
}

/**
 * Modify settings.gradle to include lc3Lib module
 */
// function withSettingsGradleModifications(config: any) {
//   return withSettingsGradle(config, config => {
//     let settingsGradle = config.modResults.contents

//     // Add lc3Lib module if not present
//     if (!settingsGradle.includes("include ':lc3Lib'")) {
//       settingsGradle += `
// include ':lc3Lib'
// project(':lc3Lib').projectDir = new File(rootDir, '../modules/core/android/lc3Lib')
// `
//     }

//     config.modResults.contents = settingsGradle
//     return config
//   })
// }

export default withAndroidWorkingConfig
