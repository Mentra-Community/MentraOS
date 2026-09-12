package com.mentra.acsmeeting.network

/**
 * An IPv4 subnet, taken from the phone's own address on a joined network.
 *
 * SoftAP correctness is an interface question, not an address-range question: the media path is
 * right when the selected candidate sits on the network we joined, and wrong otherwise. Matching
 * "looks RFC1918" or "starts with 192.168.43" answers a different question and stops being true the
 * moment an OEM picks another hotspot subnet, so every SoftAP check compares against the prefix
 * `LinkProperties` actually reported.
 */
data class Ipv4Prefix(val address: String, val prefixLength: Int) {

    private val network: Int? = packIpv4(address)?.let { it and maskFor(prefixLength) }

    /** True when [candidate] is a dotted-quad IPv4 address inside this prefix. */
    fun contains(candidate: String?): Boolean {
        val base = network ?: return false
        val value = packIpv4(candidate) ?: return false
        return (value and maskFor(prefixLength)) == base
    }

    override fun toString(): String = "$address/$prefixLength"

    companion object {
        /**
         * Dotted-quad to a packed int, or null when [token] is not one. Deliberately strict: a
         * token like `192.168.43` or `candidate:1` must not be read as an address, because the
         * callers scan whitespace-split SDP lines where most tokens are not addresses at all.
         */
        fun packIpv4(token: String?): Int? {
            val text = token ?: return null
            val octets = text.split('.')
            if (octets.size != 4) return null
            var packed = 0
            for (octet in octets) {
                if (octet.isEmpty() || octet.length > 3) return null
                val value = octet.toIntOrNull() ?: return null
                if (value < 0 || value > 255) return null
                packed = (packed shl 8) or value
            }
            return packed
        }

        /** A /0 masks nothing; Kotlin's `shl 32` is a no-op, so that case is spelled out. */
        private fun maskFor(prefixLength: Int): Int {
            val bits = prefixLength.coerceIn(0, 32)
            return if (bits == 0) 0 else (-1 shl (32 - bits))
        }
    }
}
