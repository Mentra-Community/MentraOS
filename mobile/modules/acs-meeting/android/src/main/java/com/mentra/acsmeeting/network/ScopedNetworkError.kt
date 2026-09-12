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

    /**
     * The framework reported it cannot provide this network at all.
     *
     * WifiNetworkSpecifier does not keep scanning for the request timeout. If the glasses AP is
     * not in the current scan — or the user dismissed the system join sheet — this arrives in
     * well under a second.
     */
    class Unavailable(val ssid: String) :
        ScopedNetworkError(
            CODE_UNAVAILABLE,
            "Could not join $ssid (SSID not in scan, Wi-Fi off, or the system join prompt was dismissed)",
        )

    /** The network was joined and then went away mid-call. */
    class Lost(val ssid: String) :
        ScopedNetworkError(CODE_LOST, "Lost the connection to $ssid")

    /** `requestNetwork` itself threw. */
    class RequestFailed(val reason: String) :
        ScopedNetworkError(CODE_REQUEST_FAILED, "Scoped network request failed: $reason")

    /** Joined, but no IPv4 address was assigned, so nothing can bind to the link. */
    class NoLocalAddress(val ssid: String) :
        ScopedNetworkError(CODE_NO_LOCAL_ADDRESS, "Joined $ssid but no IPv4 address was assigned")

    /**
     * Joined, but the network never became usable for ICE: a callback never reported, or the
     * address never appeared in the kernel's interface table.
     *
     * Failing here is deliberate. Proceeding produces an ICE answer with no hotspot candidate,
     * which is the same symptom as several unrelated faults and cost real time to attribute.
     */
    class NotReady(val ssid: String, val missing: String) :
        ScopedNetworkError(
            CODE_NOT_READY,
            "Joined $ssid but the network never became usable: still waiting for $missing",
        )

    /** Phone Wi-Fi radio is off. WifiNetworkSpecifier then fails as Unavailable in under a second. */
    class WifiDisabled :
        ScopedNetworkError(CODE_WIFI_DISABLED, "Phone Wi-Fi is off; turn it on before joining the glasses hotspot")

    /**
     * A VPN owns this app's UID. netd then refuses to bind our sockets to the hotspot network
     * (`EPERM`), and the glasses' TCP handshake to the WHIP listener never completes because the
     * reply path is captured by the tunnel. Verified on-device: a shell-UID listener on the same
     * address accepts the glasses' connection while an app-UID listener times out. The scoped join
     * itself succeeds, so without this check the failure only shows up ten seconds into the camera
     * step as an opaque connect timeout.
     */
    class VpnCapturesApp :
        ScopedNetworkError(
            CODE_VPN_ACTIVE,
            "A VPN is routing this app's traffic, so the glasses cannot reach the phone. " +
                "Exclude Mentra from the VPN (split tunneling) or turn the VPN off, then retry",
        )

    companion object {
        const val CODE_PERMISSION_DENIED = "SOFTAP_PERMISSION_DENIED"
        const val CODE_TIMEOUT = "SOFTAP_JOIN_TIMEOUT"
        const val CODE_UNAVAILABLE = "SOFTAP_UNAVAILABLE"
        const val CODE_LOST = "SOFTAP_NETWORK_LOST"
        const val CODE_REQUEST_FAILED = "SOFTAP_REQUEST_FAILED"
        const val CODE_NO_LOCAL_ADDRESS = "SOFTAP_NO_LOCAL_ADDRESS"
        const val CODE_NOT_READY = "SOFTAP_NETWORK_NOT_READY"
        const val CODE_WIFI_DISABLED = "SOFTAP_WIFI_DISABLED"
        const val CODE_VPN_ACTIVE = "SOFTAP_VPN_ACTIVE"

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
         * Enforced on Android 17+ for apps targeting SDK 37+. Hosts targeting older SDKs
         * retain implicit access through INTERNET and must not request this permission.
         */
        const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
