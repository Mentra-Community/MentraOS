package com.mentra.bluetoothsdk

/** One coordinated Mentra release note authored in /changelogs/<version>.md. */
data class ReleaseChangelog(
    val version: String,
    val markdown: String,
)

internal object ReleaseChangelogCatalog {
    private val baseVersionPattern = Regex("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:[-+].*)?$")

    fun select(
        fromVersion: String?,
        toVersion: String?,
    ): List<ReleaseChangelog> {
        val fallbackTarget =
            GeneratedReleaseMetadata.FAMILY_BASE_VERSION.ifBlank {
                GENERATED_RELEASE_CHANGELOGS.firstOrNull()?.version.orEmpty()
            }
        if (fallbackTarget.isBlank() && toVersion == null) return emptyList()
        val target = baseVersion(toVersion ?: fallbackTarget, "toVersion")
        if (GENERATED_RELEASE_CHANGELOGS.none { it.version == target }) {
            throw BluetoothSdkException("missing_changelog", "No changelog is bundled for target version $target.")
        }
        if (fromVersion == null) return GENERATED_RELEASE_CHANGELOGS.filter { it.version == target }

        val source = baseVersion(fromVersion, "fromVersion")
        val direction = compareVersions(target, source)
        return GENERATED_RELEASE_CHANGELOGS.filter { entry ->
            when {
                direction == 0 -> entry.version == target
                direction > 0 -> compareVersions(entry.version, source) > 0 && compareVersions(entry.version, target) <= 0
                else -> compareVersions(entry.version, source) < 0 && compareVersions(entry.version, target) >= 0
            }
        }
    }

    private fun baseVersion(
        version: String,
        label: String,
    ): String {
        val match = baseVersionPattern.matchEntire(version.trim())
            ?: throw BluetoothSdkException(
                "invalid_changelog_version",
                "$label must be a semantic version such as 3.1.0, 3.1.0-dev.4, or 3.1.0-beta.2.",
            )
        return "${match.groupValues[1]}.${match.groupValues[2]}.${match.groupValues[3]}"
    }

    private fun compareVersions(
        left: String,
        right: String,
    ): Int {
        val a = left.split(".").map(String::toInt)
        val b = right.split(".").map(String::toInt)
        for (index in 0..2) {
            if (a[index] != b[index]) return a[index] - b[index]
        }
        return 0
    }
}
