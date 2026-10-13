package com.mentra.bluetoothsdk

/** Only routing relationships and capabilities cross the bridge, never network identities. */
internal fun <N> networkDiagnostics(
    sampledAtMs: Long,
    processBound: N?,
    activeNetwork: N?,
    glassesLocal: N?,
    capabilities: (N) -> Map<String, Boolean>?,
): Map<String, Any?> {
    fun observation(network: N?): Map<String, Any?> = mapOf(
        "present" to (network != null),
        "capabilities" to network?.let(capabilities),
    )
    fun same(first: N?, second: N?): Boolean = first != null && first == second
    return mapOf(
        "sampledAtMs" to sampledAtMs,
        "processBound" to observation(processBound),
        "activeNetwork" to observation(activeNetwork),
        "glassesLocal" to observation(glassesLocal),
        "processBoundMatchesActive" to same(processBound, activeNetwork),
        "processBoundMatchesGlassesLocal" to same(processBound, glassesLocal),
        "activeNetworkMatchesGlassesLocal" to same(activeNetwork, glassesLocal),
    )
}
