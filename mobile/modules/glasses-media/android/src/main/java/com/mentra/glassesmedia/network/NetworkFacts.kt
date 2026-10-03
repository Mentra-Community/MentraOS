package com.mentra.glassesmedia.network

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * The kernel's interface table, as libwebrtc's `getifaddrs` sees it.
 *
 * Every SoftAP ICE failure so far has come from our view of the network disagreeing with
 * libwebrtc's, and the two views come from different sources. We publish
 * [ConnectivityManager.getLinkProperties][android.net.ConnectivityManager.getLinkProperties] for
 * the scoped `Network`; libwebrtc enumerates `getifaddrs` and only asks our monitor for each
 * *interface name*'s adapter type. When those disagree — an address on a name we never typed, or a
 * scoped address absent from the table entirely — no mask and no inventory can help, because ICE
 * gathers per address, not per `Network`.
 *
 * `java.net.NetworkInterface` is getifaddrs-backed, so this is the closest thing to libwebrtc's
 * own input that we can read from Kotlin. Pure enough to unit test, which matters: it is the
 * evidence the next diagnosis rests on.
 */
object NetworkFacts {

    /** One interface, with the flags libwebrtc's enumeration also keys off. */
    data class Iface(
        val name: String,
        val index: Int,
        val up: Boolean,
        val loopback: Boolean,
        val virtual: Boolean,
        val pointToPoint: Boolean,
        val mtu: Int,
        /** IPv4 only, as `address/prefixLength` — the form libwebrtc turns into a Network key. */
        val ipv4: List<String>,
    )

    /** Read the table. Never throws: a diagnostic that crashes the call is worse than no data. */
    fun snapshot(): List<Iface> =
        runCatching {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().map { candidate ->
                Iface(
                    name = candidate.name ?: "?",
                    index = runCatching { candidate.index }.getOrDefault(-1),
                    up = runCatching { candidate.isUp }.getOrDefault(false),
                    loopback = runCatching { candidate.isLoopback }.getOrDefault(false),
                    virtual = runCatching { candidate.isVirtual }.getOrDefault(false),
                    pointToPoint = runCatching { candidate.isPointToPoint }.getOrDefault(false),
                    mtu = runCatching { candidate.mtu }.getOrDefault(-1),
                    ipv4 =
                        runCatching {
                            candidate.interfaceAddresses
                                .filter { it.address is Inet4Address }
                                .map { "${it.address.hostAddress}/${it.networkPrefixLength}" }
                        }.getOrDefault(emptyList()),
                )
            }
        }.getOrElse { emptyList() }

    /**
     * Only interfaces that can carry a host candidate: up, non-loopback, with an IPv4 address.
     * Anything here is something ICE may gather on.
     */
    fun gatherable(table: List<Iface> = snapshot()): List<Iface> =
        table.filter { it.up && !it.loopback && it.ipv4.isNotEmpty() }

    /** The interface the kernel says owns [address], or null when the table has never seen it. */
    fun ownerOf(address: String, table: List<Iface> = snapshot()): String? =
        table.firstOrNull { iface -> iface.ipv4.any { it.substringBefore('/') == address } }?.name

    /** One log line per interface, flags abbreviated so a full table fits in a logcat entry. */
    fun render(table: List<Iface>): String =
        table.joinToString(" ") { iface ->
            val flags =
                buildString {
                    if (iface.up) append("U")
                    if (iface.loopback) append("L")
                    if (iface.virtual) append("V")
                    if (iface.pointToPoint) append("P")
                }
            "${iface.name}#${iface.index}[$flags mtu=${iface.mtu}](${iface.ipv4.joinToString(",")})"
        }
}
