package com.mentra.acsmeeting.network

/**
 * Typed failures for a scoped SoftAP join.
 *
 * A denied local-network permission must surface as a distinct, immediate error rather than a
 * 30-second hang that looks like a flaky hotspot. `ACCESS_LOCAL_NETWORK` sits in the nearby-devices
 * group, so it is often already granted during development and easy to miss until a user without it
 * hits a silent timeout.
 */
sealed class ScopedNetworkError(val code: String, message: String) : Exception(message) {

    /** `ACCESS_LOCAL_NETWORK` (or the nearby-devices prerequisite) was not granted. */
    class PermissionDenied(val permission: String) :
        ScopedNetworkError(
            CODE_PERMISSION_DENIED,
            "Local network permission not granted: $permission",
        )

    /** No usable network arrived before the request timeout. */
    class Timeout(val ssid: String, val timeoutMs: Int) :
        ScopedNetworkError(CODE_TIMEOUT, "Timed out joining $ssid after ${timeoutMs}ms")

    /** The framework reported it cannot provide this network at all. */
    class Unavailable(val ssid: String) :
        ScopedNetworkError(CODE_UNAVAILABLE, "Could not join $ssid")

    /** The network was joined and then went away mid-call. */
    class Lost(val ssid: String) :
        ScopedNetworkError(CODE_LOST, "Lost the connection to $ssid")

    /** `requestNetwork` itself threw. */
    class RequestFailed(val reason: String) :
        ScopedNetworkError(CODE_REQUEST_FAILED, "Scoped network request failed: $reason")

    /** Joined, but no IPv4 address was assigned, so nothing can bind to the link. */
    class NoLocalAddress(val ssid: String) :
        ScopedNetworkError(CODE_NO_LOCAL_ADDRESS, "Joined $ssid but no IPv4 address was assigned")

    companion object {
        const val CODE_PERMISSION_DENIED = "SOFTAP_PERMISSION_DENIED"
        const val CODE_TIMEOUT = "SOFTAP_JOIN_TIMEOUT"
        const val CODE_UNAVAILABLE = "SOFTAP_UNAVAILABLE"
        const val CODE_LOST = "SOFTAP_NETWORK_LOST"
        const val CODE_REQUEST_FAILED = "SOFTAP_REQUEST_FAILED"
        const val CODE_NO_LOCAL_ADDRESS = "SOFTAP_NO_LOCAL_ADDRESS"

        /** Map a terminal state-machine failure onto the typed error the call path reports. */
        fun from(failure: ScopedNetworkState.Failure, ssid: String, timeoutMs: Int): ScopedNetworkError? =
            when (failure) {
                ScopedNetworkState.Failure.NONE -> null
                ScopedNetworkState.Failure.TIMEOUT -> Timeout(ssid, timeoutMs)
                ScopedNetworkState.Failure.UNAVAILABLE -> Unavailable(ssid)
                ScopedNetworkState.Failure.LOST -> Lost(ssid)
                ScopedNetworkState.Failure.PERMISSION_DENIED -> PermissionDenied(LOCAL_NETWORK_PERMISSION)
                ScopedNetworkState.Failure.REQUEST_FAILED -> RequestFailed("requestNetwork threw")
            }

        /**
         * Enforced for apps targeting SDK 37+. `targetSdkVersion` is 35 today, so access is still
         * implicit, but the WHIP ingest server accepts inbound TCP and exchanges UDP on a private
         * LAN address — exactly the operations this permission governs — so it is declared now
         * rather than discovered on the targetSdk bump.
         */
        const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
