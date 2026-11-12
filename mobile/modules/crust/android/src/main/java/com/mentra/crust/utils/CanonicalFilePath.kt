package com.mentra.crust.utils

import java.io.File
import java.io.IOException

/**
 * The real location of a path, for checking that a path a miniapp names stays inside the
 * directory the host allows: absolute, with `.`, `..` and every symlink resolved.
 */
object CanonicalFilePath {
    /** The canonical path of an existing file or directory, or null when there is none. */
    fun of(path: String): String? {
        if (!path.startsWith("/") || path.contains('\u0000')) return null
        return try {
            File(path).canonicalFile.takeIf { it.exists() }?.path
        } catch (e: IOException) {
            null
        } catch (e: SecurityException) {
            null
        }
    }
}
