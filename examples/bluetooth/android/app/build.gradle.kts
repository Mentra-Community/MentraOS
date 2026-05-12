import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val defaultGstreamerRoot = layout.projectDirectory.dir("../.gstreamer/Android.sdk").asFile
val gstreamerRoot = providers.gradleProperty("gstreamerRootAndroid")
    .orElse(providers.environmentVariable("GSTREAMER_ROOT_ANDROID"))
    .orElse(providers.provider { defaultGstreamerRoot.absolutePath })
val gstreamerRootFile = File(gstreamerRoot.get())
val gstreamerArchRootFile = File(gstreamerRootFile, "share/gst-android/ndk-build/gstreamer-1.0.mk")
    .takeIf { it.isFile }
    ?.let { gstreamerRootFile }
    ?: File(gstreamerRootFile, "arm64")
val gstreamerSdkMarker = File(gstreamerArchRootFile, "share/gst-android/ndk-build/gstreamer-1.0.mk")
val gstreamerGeneratedJavaDir = layout.buildDirectory.dir("generated/gstreamer/java").get().asFile

val installGStreamerAndroidSdk = tasks.register<Exec>("installGStreamerAndroidSdk") {
    val setupScript = layout.projectDirectory.file("../scripts/setup-gstreamer-android.sh").asFile
    group = "setup"
    description = "Downloads the GStreamer Android SDK when it is not installed yet."
    onlyIf { !gstreamerSdkMarker.isFile }
    inputs.file(setupScript)
    outputs.file(gstreamerSdkMarker)
    commandLine(setupScript.absolutePath)
    environment("GSTREAMER_ROOT_ANDROID", gstreamerRootFile.absolutePath)
}

android {
    namespace = "com.mentra.examples.android"
    compileSdk = 35
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "com.mentra.examples.android"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        externalNativeBuild {
            ndkBuild {
                arguments(
                    "GSTREAMER_ROOT_ANDROID=${gstreamerArchRootFile.absolutePath}",
                    "GSTREAMER_JAVA_SRC_DIR=${gstreamerGeneratedJavaDir.absolutePath}",
                    "GSTREAMER_ASSETS_DIR=src/main/assets",
                    "GSTREAMER_INCLUDE_FONTS=no",
                    "GSTREAMER_INCLUDE_CA_CERTIFICATES=no",
                )
                abiFilters += listOf("arm64-v8a")
                targets += listOf("mentra_android_webrtc_receiver")
            }
        }
    }

    buildFeatures {
        compose = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    externalNativeBuild {
        ndkBuild {
            path = file("src/main/jni/Android.mk")
        }
    }
    packaging {
        jniLibs {
            pickFirsts += "**/libc++_shared.so"
            pickFirsts += "**/libonnxruntime.so"
            pickFirsts += "**/libonnxruntime4j_jni.so"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.02.00")
    implementation(composeBom)
    implementation("com.mentra:bluetooth-sdk:${property("mentraSdkVersion")}")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("io.coil-kt:coil-compose:2.6.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    debugImplementation("androidx.compose.ui:ui-tooling")
}

tasks.configureEach {
    if (name == "preBuild" || name.startsWith("externalNativeBuild") || name.contains("NdkBuild")) {
        dependsOn(installGStreamerAndroidSdk)
    }
}
