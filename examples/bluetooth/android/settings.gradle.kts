pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        mavenLocal()
        maven("https://www.jitpack.io")

        // Partner releases may require a private Mentra Maven repository.
        // Add the repository URL and credentials supplied by Mentra here or in
        // your organization's Gradle init script.
    }
}

rootProject.name = "MentraBareAndroidExample"
include(":app")
