package com.mentra.glassesmedia.source

import com.mentra.glassesmedia.network.Ipv4Prefix
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * This verifier is acceptance evidence for the SoftAP path, so its failure mode matters as much as
 * its success one. The cases below pin that it follows the transport's selection instead of
 * guessing, and that it reports insufficient evidence rather than passing on a plausible-looking
 * pair — the previous behaviour, which could grade a run on a pair that was not carrying the call.
 */
class SelectedIcePairTest {

    private val prefix = Ipv4Prefix("192.168.43.20", 24)

    private fun pair(
        id: String,
        state: String? = "succeeded",
        nominated: Boolean = false,
        local: String? = "local-1",
        remote: String? = "remote-1",
        bytes: Long = 0,
    ) = IceCandidatePairStats(id, state, nominated, local, remote, bytes)

    private fun transport(selected: String? = "a", id: String = "T1") = IceTransportStats(id, selected)

    private fun candidates(vararg entries: Pair<String, String>): Map<String, IceCandidateStats> =
        entries.associate { (id, address) -> id to IceCandidateStats(id, address, "host") }

    private fun verdict(
        transports: List<IceTransportStats> = listOf(transport()),
        pairs: List<IceCandidatePairStats> = listOf(pair("a", bytes = 9000)),
        candidateMap: Map<String, IceCandidateStats> =
            candidates("local-1" to "192.168.43.20", "remote-1" to "192.168.43.1"),
        scopedPrefix: Ipv4Prefix? = prefix,
        iceGeneration: Int = 3,
    ) = SelectedIcePair.verdict(transports, pairs, candidateMap, scopedPrefix, iceGeneration)

    @Test
    fun `follows the pair the transport says is selected`() {
        val chosen =
            SelectedIcePair.selected(
                listOf(transport(selected = "b")),
                listOf(pair("a", nominated = true, bytes = 999_999), pair("b")),
            )

        assertEquals("b", chosen.getOrNull()?.id)
    }

    /**
     * The behaviour that had to go. A succeeded pair is one that once passed a check, and historical
     * bytes can belong to a pair that has since been replaced; neither is the current path.
     */
    @Test
    fun `no fallback to a succeeded or high-traffic pair when nothing is selected`() {
        val chosen =
            SelectedIcePair.selected(
                listOf(transport(selected = null)),
                listOf(pair("a", nominated = true, bytes = 999_999)),
            )

        assertTrue(chosen.isFailure)
        assertEquals("no_selected_pair", (chosen.exceptionOrNull() as SelectedIcePair.Missing).reason)
    }

    @Test
    fun `a local candidate inside the prefix is on the hotspot`() {
        assertEquals(
            IcePathVerdict.OnHotspot("a", 3, "192.168.43.20", "192.168.43.1", 9000),
            verdict(),
        )
    }

    /** The silent failure this exists for: SDP looked private, ICE picked cellular. */
    @Test
    fun `a cellular local candidate is off the hotspot`() {
        val result =
            verdict(
                candidateMap = candidates("local-1" to "10.171.36.4", "remote-1" to "192.168.43.1"),
            )

        assertEquals(IcePathVerdict.OffHotspot("a", "10.171.36.4", "192.168.43.20/24"), result)
    }

    @Test
    fun `every gap in the evidence is its own unknown reason`() {
        assertEquals(
            IcePathVerdict.Unknown("no_transport_stats"),
            verdict(transports = emptyList()),
        )
        assertEquals(
            IcePathVerdict.Unknown("no_selected_pair"),
            verdict(transports = listOf(transport(selected = null))),
        )
        assertEquals(
            IcePathVerdict.Unknown("selected_pair_absent_from_report"),
            verdict(pairs = listOf(pair("z"))),
        )
        assertEquals(IcePathVerdict.Unknown("no_scoped_prefix"), verdict(scopedPrefix = null))
        assertEquals(IcePathVerdict.Unknown("no_local_candidate"), verdict(candidateMap = emptyMap()))
    }

    @Test
    fun `an OEM hotspot on another subnet still passes`() {
        val result =
            verdict(
                candidateMap = candidates("local-1" to "192.168.49.37", "remote-1" to "192.168.49.1"),
                scopedPrefix = Ipv4Prefix("192.168.49.37", 24),
            )

        assertTrue(result is IcePathVerdict.OnHotspot)
    }

    // -----------------------------------------------------------------
    // Byte growth, compared only within one path
    // -----------------------------------------------------------------

    private fun onHotspot(pairId: String = "a", generation: Int = 3, bytes: Long) =
        IcePathVerdict.OnHotspot(pairId, generation, "192.168.43.20", "192.168.43.1", bytes)

    @Test
    fun `growth on the same pair and generation is a real comparison`() {
        val flow = SelectedIcePair.flow(onHotspot(bytes = 1000), onHotspot(bytes = 4000))

        assertEquals(SelectedIcePair.Flow.Compared(1000, 4000), flow)
        assertTrue((flow as SelectedIcePair.Flow.Compared).flowing)
    }

    @Test
    fun `a flat counter on the same pair is not flowing`() {
        val flow = SelectedIcePair.flow(onHotspot(bytes = 4000), onHotspot(bytes = 4000))

        assertTrue(flow is SelectedIcePair.Flow.Compared)
        assertTrue(!(flow as SelectedIcePair.Flow.Compared).flowing)
    }

    /**
     * The regression that made the old check meaningless: two samples were compared with no pair
     * identity, so a renomination could turn an idle path into an apparently flowing one.
     */
    @Test
    fun `a pair change between samples is not comparable rather than flowing`() {
        val flow = SelectedIcePair.flow(onHotspot(pairId = "a", bytes = 0), onHotspot(pairId = "b", bytes = 9000))

        assertEquals(SelectedIcePair.Flow.NotComparable("pair_changed"), flow)
    }

    @Test
    fun `a session restart between samples is not comparable`() {
        val flow =
            SelectedIcePair.flow(onHotspot(generation = 3, bytes = 0), onHotspot(generation = 4, bytes = 9000))

        assertEquals(SelectedIcePair.Flow.NotComparable("ice_generation_changed"), flow)
    }

    /** A first sample with no verdict cannot stand in for zero bytes; that would fake growth. */
    @Test
    fun `an unusable first sample is not treated as zero bytes`() {
        val flow = SelectedIcePair.flow(IcePathVerdict.Unknown("no_selected_pair"), onHotspot(bytes = 9000))

        assertEquals(SelectedIcePair.Flow.NotComparable("first_sample_unusable"), flow)
    }
}
