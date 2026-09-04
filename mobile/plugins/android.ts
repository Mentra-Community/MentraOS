import {execSync} from "child_process"
import fs from "fs"
import path from "path"

import {
  ConfigPlugin,
  withAppBuildGradle,
  withProjectBuildGradle,
  withSettingsGradle,
  withGradleProperties,
  withAndroidManifest,
} from "@expo/config-plugins"

import {withDebugAbiFilters} from "../scripts/android-abi-filters.mjs"

/**
 * Expo Config Plugin to apply android-working modifications
 * This ensures that after running expo prebuild, all custom Android configurations are preserved
 */
const ANDROIDX_BROWSER_VERSION = "1.6.0"
const ANDROIDX_ACTIVITY_VERSION = "1.9.3"
const ANDROIDX_ANNOTATION_VERSION = "1.3.0"
const ANDROIDX_BROWSER_PIN_MARKER = "androidXBrowserVersion = "
const ANDROIDX_RESOLUTION_MARKER = "force 'androidx.browser:browser:"

const withAndroidWorkingConfig: ConfigPlugin = (config) => {
  // Apply all modifications in sequence
  config = withProjectBuildGradleModifications(config)
  config = withAppBuildGradleModifications(config)
  config = withAndroidManifestModifications(config)
  config = withXmlResourceFiles(config)
  config = withGradlePropertiesModifications(config)
  config = withSettingsGradleModifications(config)

  return config
}

/**
 * MSAL's `common` dependency still references the Surface Duo display-mask
 * artifact, which Microsoft publishes outside Maven Central. Restrict this
 * repository to that one group so other dependencies continue resolving from
 * the normal repositories. The same hook also pins AndroidX dependencies used
 * by react-native-inappbrowser-reborn.
 *
 * react-native-inappbrowser-reborn requests androidx.browser:browser:1.4.+.
 * That dynamic range requires maven-metadata.xml from Google Maven. When the
 * listing is missing or unreachable, Gradle fails with "no versions of
 * androidx.browser:browser are available". Pin a concrete cached version
 * through the library's rootProject.ext hook and force it for every
 * configuration. Browser 1.9.0 also pulls androidx.activity:activity:1.9.0,
 * which is not in the local cache and 404s on Google Maven — keep activity
 * on 1.9.3 when that exact version is requested.
 */
function withProjectBuildGradleModifications(config: any) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== "groovy") {
      return config
    }

    let gradle = config.modResults.contents
    const msalRepositoryMarker = "entra-auth: Microsoft display-mask Maven repository"
    if (!gradle.includes(msalRepositoryMarker)) {
      const repository = `    maven {
      // ${msalRepositoryMarker}
      url 'https://pkgs.dev.azure.com/MicrosoftDeviceSDK/DuoSDK-Public/_packaging/Duo-SDK-Feed/maven/v1'
      content {
        includeGroup("com.microsoft.device.display")
      }
    }`
      const repositories = gradle.match(/allprojects\s*\{[\s\S]*?repositories\s*\{/)

      if (repositories) {
        const insertionPoint = (repositories.index ?? 0) + repositories[0].length
        gradle = gradle.slice(0, insertionPoint) + "\n" + repository + gradle.slice(insertionPoint)
      } else {
        gradle += `\nallprojects {\n  repositories {\n${repository}\n  }\n}\n`
      }
    }

    const resolutionBlock = `
allprojects {
  configurations.all {
    resolutionStrategy {
      eachDependency { details ->
        if (details.requested.group == 'androidx.browser' && details.requested.name == 'browser') {
          details.useVersion '${ANDROIDX_BROWSER_VERSION}'
        }
        if (details.requested.group == 'androidx.activity' && details.requested.name == 'activity' && details.requested.version == '1.9.0') {
          details.useVersion '${ANDROIDX_ACTIVITY_VERSION}'
        }
        if (details.requested.group == 'androidx.annotation' && details.requested.name == 'annotation' && details.requested.version.endsWith('+')) {
          details.useVersion '${ANDROIDX_ANNOTATION_VERSION}'
        }
      }
      force 'androidx.browser:browser:${ANDROIDX_BROWSER_VERSION}'
    }
  }
}
`

    if (gradle.includes(ANDROIDX_BROWSER_PIN_MARKER)) {
      gradle = gradle.replace(
        /androidXBrowserVersion = "[^"]+"/,
        `androidXBrowserVersion = "${ANDROIDX_BROWSER_VERSION}"`,
      )
      if (gradle.includes("androidXAnnotationVersion = ")) {
        gradle = gradle.replace(
          /androidXAnnotationVersion = "[^"]+"/,
          `androidXAnnotationVersion = "${ANDROIDX_ANNOTATION_VERSION}"`,
        )
      } else {
        gradle = gradle.replace(
          /androidXBrowserVersion = "[^"]+"/,
          `androidXBrowserVersion = "${ANDROIDX_BROWSER_VERSION}"\n  androidXAnnotationVersion = "${ANDROIDX_ANNOTATION_VERSION}"`,
        )
      }
    } else {
      const extBlock = `
// Pin AndroidX Browser/Annotation for react-native-inappbrowser-reborn (avoids 1.4.+/1.5.+ metadata lookup).
ext {
  androidXBrowserVersion = "${ANDROIDX_BROWSER_VERSION}"
  androidXAnnotationVersion = "${ANDROIDX_ANNOTATION_VERSION}"
}
`

      const applyPluginIndex = gradle.indexOf("apply plugin")
      if (applyPluginIndex !== -1) {
        gradle = `${gradle.slice(0, applyPluginIndex)}${extBlock}\n${gradle.slice(applyPluginIndex)}`
      } else {
        gradle = `${gradle}\n${extBlock}`
      }
    }

    if (gradle.includes(ANDROIDX_RESOLUTION_MARKER)) {
      gradle = gradle.replace(
        /\nallprojects \{\n  configurations.all \{\n    resolutionStrategy \{[\s\S]*?force 'androidx.browser:browser:[^']+'[\s\S]*?\n  \}\n\}\n?/,
        resolutionBlock,
      )
    } else {
      gradle += resolutionBlock
    }

    config.modResults.contents = gradle
    return config
  })
}

// Derive the active Android applicationId. Honors MENTRAOS_BUILD_NAME so that
// build-variant suffixes flow through manifest entries that would otherwise
// hardcode the base package (e.g. the DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION).
function getAndroidPackageName(config: any): string {
  return config?.android?.package || "com.mentra.mentra"
}

/**
 * Modify app/build.gradle to add custom configurations
 */
function withAppBuildGradleModifications(config: any) {
  return withAppBuildGradle(config, (config) => {
    let buildGradle = config.modResults.contents

    // 0. Remove any unconditional sentry.gradle apply added by @sentry/react-native expo plugin
    // We use our own conditional apply gated on sentryUploadEnabled property
    // ^apply matches only unindented (top-level) applies; the conditional one inside
    // the if block is indented and won't match
    buildGradle = buildGradle.replace(/^apply from:.*sentry\.gradle.*\n*/gm, "")

    // 1. Add release credentials and conditional Sentry script (after jscFlavor)
    if (!buildGradle.includes("releaseStorePassword =")) {
      // China builds (EXPO_PUBLIC_DEPLOYMENT_REGION=china) use a separate keystore
      // so the global upload key cannot accidentally sign a China APK.
      const isChinaBuild = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china"
      const keystoreFilename = isChinaBuild ? "china-upload-keystore.jks" : "upload-keystore.jks"
      const regionLabel = isChinaBuild ? "china" : "default"
      const credentialsAndSentry = `
/**
 * Release-Store credentials.
 * Looks for keystore in shared location (~/.mentra/credentials/) first,
 * then falls back to repo-local credentials/ folder.
 * Keystore filename is selected at prebuild time based on EXPO_PUBLIC_DEPLOYMENT_REGION.
 * If no keystore is found, falls back to debug keystore for local development.
 */
def releaseStorePassword = project.hasProperty("MENTRAOS_UPLOAD_STORE_PASSWORD") ? project.property("MENTRAOS_UPLOAD_STORE_PASSWORD") : ""
def releaseKeyPassword = project.hasProperty("MENTRAOS_UPLOAD_KEY_PASSWORD") ? project.property("MENTRAOS_UPLOAD_KEY_PASSWORD") : ""
def releaseKeyAlias = project.hasProperty("MENTRAOS_UPLOAD_KEY_ALIAS") ? project.property("MENTRAOS_UPLOAD_KEY_ALIAS") : "upload"
def releaseRegion = "${regionLabel}"

// Find keystore: check shared location first, then local
def sharedKeystore = new File(System.getProperty("user.home"), ".mentra/credentials/${keystoreFilename}")
def localKeystore = file('../../credentials/${keystoreFilename}')
def releaseKeystoreFile = sharedKeystore.exists() ? sharedKeystore : (localKeystore.exists() ? localKeystore : null)

// Check if we have valid release signing credentials
def hasReleaseSigningConfig = releaseKeystoreFile != null && releaseStorePassword

// Print signing configuration being used
println ""
println "=============================================="
println "[MentraOS] Signing Configuration"
println "=============================================="
println "  Region: \${releaseRegion}"
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

    // 2. Add externalNativeBuild configuration in defaultConfig
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

    // 3. Add additional packagingOptions
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

    // 8. Filter debug APK native libs to reactNativeArchitectures. Release/AAB stay unfiltered.
    buildGradle = withDebugAbiFilters(buildGradle)

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
    const pkg = getAndroidPackageName(config)

    // Remove permissions that Google Play doesn't allow for our use case
    // We only SAVE photos from glasses - we don't need to READ the user's photo library
    // expo-media-library and expo-screen-capture add these via their AAR manifests,
    // so we must remove them AND use tools:node="remove" for Play Store compliance
    // Google's Photo and Video Permissions policy requires apps to use Photo Picker for one-time access
    const permissionsToRemove = [
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.WRITE_MEDIA_VIDEO", // Not needed - MediaStore API works without it on API 29+
      "android.permission.ACCESS_MEDIA_LOCATION", // Not needed - we save photos, don't read EXIF from user's library
    ]

    // Ensure tools namespace is available for manifest merger directives
    if (!manifest.$["xmlns:tools"]) {
      manifest.$["xmlns:tools"] = "http://schemas.android.com/tools"
    }
    if (!manifest["uses-permission"]) {
      manifest["uses-permission"] = []
    }

    // Filter out permissions we want to remove from the Expo-generated manifest
    manifest["uses-permission"] = manifest["uses-permission"].filter(
      (p: any) => !permissionsToRemove.includes(p.$["android:name"]),
    )

    // Also add tools:node="remove" so the Gradle manifest merger strips these
    // even when libraries (e.g. expo-screen-capture) re-add them via their own AAR manifests
    permissionsToRemove.forEach((permName) => {
      const existing = manifest["uses-permission"].find(
        (p: any) => p.$["android:name"] === permName && p.$["tools:node"] === "remove",
      )
      if (!existing) {
        manifest["uses-permission"].push({
          $: {
            "android:name": permName,
            "tools:node": "remove",
          },
        })
      }
    })

    // Remove AD_ID permission via tools:node="remove" so the manifest merger strips it
    // even when Firebase Analytics adds it via transitive dependencies
    const adIdPerm = manifest["uses-permission"].find(
      (p: any) => p.$["android:name"] === "com.google.android.gms.permission.AD_ID",
    )
    if (adIdPerm) {
      adIdPerm.$["tools:node"] = "remove"
    } else {
      manifest["uses-permission"].push({
        $: {
          "android:name": "com.google.android.gms.permission.AD_ID",
          "tools:node": "remove",
        },
      })
    }

    // Add permissions that need to be added
    const permissionsToAdd = [
      {name: "android.permission.BLUETOOTH", maxSdkVersion: 30},
      {name: "android.permission.BLUETOOTH_ADMIN", maxSdkVersion: 30},
      {name: "android.permission.BLUETOOTH_ADVERTISE"},
      {name: "android.permission.BLUETOOTH_CONNECT"},
      {name: "android.permission.BLUETOOTH_SCAN"},
      {name: "android.permission.FOREGROUND_SERVICE"},
      {name: "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"},
      {name: "android.permission.FOREGROUND_SERVICE_DATA_SYNC"},
      {name: "android.permission.FOREGROUND_SERVICE_LOCATION"},
      {name: "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"},
      {name: "android.permission.FOREGROUND_SERVICE_MICROPHONE"},
      {name: "android.permission.NEARBY_DEVICES"},
      {name: "android.permission.POST_NOTIFICATIONS"},
      {name: "android.permission.QUERY_ALL_PACKAGES"},
      {name: "android.permission.READ_PHONE_STATE"},
      {name: "android.permission.RECEIVE_BOOT_COMPLETED"},
      {name: `${config.android?.package}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`},
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
    const customPermName = `${pkg}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
    const customPermExists = manifest.permission.find((p: any) => p.$["android:name"] === customPermName)
    if (!customPermExists) {
      manifest.permission.push({
        $: {
          "android:name": customPermName,
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

      // Android navigation runs on the Mapbox Navigation SDK (migrated off
      // the Google Navigation SDK), so the Google geo API_KEY meta-data is
      // no longer injected here. iOS still uses the Google Nav SDK
      // (GoogleNavigation pod + GOOGLE_NAV_API_KEY in Info.plist) until the
      // iOS migration lands -- that path is untouched. See
      // issues/mapbox-navigation-migration.md.
      const isChinaBuild = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china"
      if (!app["meta-data"]) {
        app["meta-data"] = []
      }

      // The official binary can be enrolled into a workspace that disables
      // telemetry. Keep Firebase Analytics off during native startup; the
      // JavaScript deployment gate enables collection only after the embedded
      // consumer profile or an opted-in workspace has been resolved.
      const analyticsCollection = app["meta-data"].find(
        (m: any) => m.$["android:name"] === "firebase_analytics_collection_enabled",
      )
      if (analyticsCollection) {
        analyticsCollection.$["android:value"] = "false"
        analyticsCollection.$["tools:replace"] = "android:value"
      } else {
        app["meta-data"].push({
          $: {
            "android:name": "firebase_analytics_collection_enabled",
            "android:value": "false",
            "tools:replace": "android:value",
          },
        })
      }

      // Inject the Mapbox runtime token (pk....) as manifest meta-data
      // `com.mapbox.token`. NavigationManager.kt reads this tag from the
      // merged manifest at boot and passes it to MapboxOptions.accessToken —
      // the same provisioning shape the Google geo key above uses. Public
      // token, safe to ship. The secret Downloads:Read token (sk....) is
      // build-time-only (~/.gradle/gradle.properties) and never reaches the
      // manifest. Fail loudly in CI/EAS; warn in local dev.
      // See issues/mapbox-navigation-migration.md.
      if (!isChinaBuild) {
        const mapboxToken = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? ""
        if (!mapboxToken) {
          const isCiOrEas =
            process.env.CI === "true" ||
            process.env.CI === "1" ||
            process.env.EAS_BUILD === "true" ||
            process.env.NODE_ENV === "production"
          const msg =
            "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN is not set. Android navigation will fail at runtime -- " +
            "set it in mobile/.env (see mobile/.env.example) before building."
          if (isCiOrEas) {
            throw new Error(msg)
          }
          console.warn(`[mobile/plugins/android] ${msg}`)
        }
        const existingMapbox = app["meta-data"].find((m: any) => m.$["android:name"] === "com.mapbox.token")
        if (existingMapbox) {
          existingMapbox.$["android:value"] = mapboxToken
        } else {
          app["meta-data"].push({
            $: {
              "android:name": "com.mapbox.token",
              "android:value": mapboxToken,
            },
          })
        }
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
        const hasExtraScheme = schemeFilter.data.some((d: any) => d.$["android:scheme"] === config.android?.package)

        if (!hasExtraScheme) {
          schemeFilter.data.push({
            $: {"android:scheme": config.android?.package},
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

    // On Windows, leave node resolution to PATH to avoid malformed JVM args under Program Files.
    if (process.platform === "win32") {
      config.modResults = props
      return config
    }

    // Get node path and add to org.gradle.jvmargs
    try {
      const nodeExecutable = execSync("which node", {encoding: "utf-8"}).trim()
      // Get parent directory of bin (e.g., /path/to/node/bin/node -> /path/to/node)
      const nodePath = path.dirname(nodeExecutable)

      // Find existing org.gradle.jvmargs property
      const jvmArgsIndex = props.findIndex((p) => p.type === "property" && p.key === "org.gradle.jvmargs")

      if (jvmArgsIndex !== -1) {
        const jvmArgsProp = props[jvmArgsIndex]
        if (jvmArgsProp.type === "property" && "value" in jvmArgsProp) {
          let currentValue = jvmArgsProp.value
          // Increase heap and metaspace to avoid OOM during release builds
          currentValue = currentValue.replace(/-Xmx\d+m/, "-Xmx8192m")
          currentValue = currentValue.replace(/-XX:MaxMetaspaceSize=\d+m/, "-XX:MaxMetaspaceSize=2048m")
          if (!currentValue.includes("-Dorg.gradle.project.nodePath=")) {
            currentValue = `${currentValue} -Dorg.gradle.project.nodePath=${nodePath}`
          }
          jvmArgsProp.value = currentValue
        }
      } else {
        // Create new jvmargs property with nodePath
        props.push({
          type: "property",
          key: "org.gradle.jvmargs",
          value: `-Xmx8192m -XX:MaxMetaspaceSize=2048m -Dorg.gradle.project.nodePath=${nodePath}`,
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
 * Modify settings.gradle to include lc3Lib module.
 *
 * The native LC3 codec lives inside `modules/bluetooth-sdk/android/lc3Lib`
 * (it moved from the legacy `core` module during the bluetooth-sdk refactor).
 * The bluetooth-sdk's build.gradle references `implementation project(':lc3Lib')`,
 * so we have to register that gradle subproject pointing at the right path —
 * Expo prebuild doesn't generate this on its own.
 */
function withSettingsGradleModifications(config: any) {
  return withSettingsGradle(config, (config) => {
    let settingsGradle = config.modResults.contents

    if (!settingsGradle.includes("include ':lc3Lib'")) {
      settingsGradle += `
include ':lc3Lib'
project(':lc3Lib').projectDir = new File(rootDir, '../modules/bluetooth-sdk/android/lc3Lib')
`
    }

    config.modResults.contents = settingsGradle
    return config
  })
}

export default withAndroidWorkingConfig
