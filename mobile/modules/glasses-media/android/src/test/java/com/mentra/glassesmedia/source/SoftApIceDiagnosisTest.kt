package com.mentra.glassesmedia.source

import com.mentra.glassesmedia.network.Ipv4Prefix
import com.mentra.glassesmedia.network.ScopedNetworkChangeDetector.PublishedEntry
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Each case here is a fault that really happened on device and was reported under the same error
 * code as the others. If two of these ever collapse to one [SoftApIceDiagnosis.Fault], the next
 * regression gets misattributed the way the handle change was.
 */
class SoftApIceDiagnosisTest {

  private val prefix = Ipv4Prefix("192.168.43.79", 24)
  private val hotspot = PublishedEntry("wlan0", "CONNECTION_WIFI", 0L, listOf("192.168.43.79"))

  private fun onHotspot(address: String = "192.168.43.79") =
    SoftApIceDiagnosis.CandidateFact(address, "wlan0", true)

  private fun offHotspot(address: String = "10.48.51.7", owner: String? = "rmnet_data0") =
    SoftApIceDiagnosis.CandidateFact(address, owner, false)

  private fun diagnose(
    scopedAddress: String? = "192.168.43.79",
    scopedOwner: String? = "wlan0",
    published: List<PublishedEntry> = listOf(hotspot),
    candidates: List<SoftApIceDiagnosis.CandidateFact> = emptyList(),
  ) = SoftApIceDiagnosis.diagnose(scopedAddress, scopedOwner, prefix, published, candidates)

  /** The address landed in the table after `onAvailable`, so gathering had nothing to find. */
  @Test
  fun `an address absent from the kernel table is a missing interface`() {
    val diagnosis = diagnose(scopedOwner = null)

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.MISSING_INTERFACE)
    assertThat(diagnosis.code).isEqualTo(SoftApIceDiagnosis.CODE_NO_CANDIDATES)
    assertThat(diagnosis.scopedInTable).isFalse
  }

  @Test
  fun `no scoped address at all is a missing interface`() {
    assertThat(diagnose(scopedAddress = null, scopedOwner = null).fault)
      .isEqualTo(SoftApIceDiagnosis.Fault.MISSING_INTERFACE)
  }

  /** The hotspot never reached libwebrtc's inventory, so the interface was skipped entirely. */
  @Test
  fun `an inventory without the hotspot is an erased entry`() {
    val diagnosis =
      diagnose(published = listOf(PublishedEntry("rmnet_data0", "CONNECTION_4G", 7L, listOf("10.48.51.7"))))

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.ERASED_ENTRY)
  }

  /**
   * The regression the decoys caused: two entries on [UNBINDABLE_HANDLE] overwrote each other in a
   * monitor keyed by handle, and the survivor was whichever connected last.
   */
  @Test
  fun `two entries sharing a handle is an erased entry even when the hotspot is present`() {
    val diagnosis =
      diagnose(
        published =
          listOf(hotspot, PublishedEntry("rmnet_data0", "CONNECTION_4G", 0L, listOf("10.48.51.7"))),
      )

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.ERASED_ENTRY)
    assertThat(diagnosis.hasHandleCollision()).isTrue
  }

  /** Address present, entry published, nothing gathered: only the socket bind is left. */
  @Test
  fun `zero candidates with everything else in place is a failed binding`() {
    val diagnosis = diagnose()

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.FAILED_BINDING)
    assertThat(diagnosis.code).isEqualTo(SoftApIceDiagnosis.CODE_NO_CANDIDATES)
  }

  /** A port truthfully on the hotspot that advertised the phone's cellular address. */
  @Test
  fun `candidates that are all off-hotspot is a wrong address`() {
    val diagnosis = diagnose(candidates = listOf(offHotspot()))

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.WRONG_ADDRESS)
    assertThat(diagnosis.code).isEqualTo(SoftApIceDiagnosis.CODE_ONLY_NON_HOTSPOT)
    assertThat(diagnosis.offHotspot).hasSize(1)
  }

  @Test
  fun `a hotspot candidate among off-hotspot ones is not classified as wrong address`() {
    val diagnosis = diagnose(candidates = listOf(offHotspot(), onHotspot()))

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.INDETERMINATE)
    assertThat(diagnosis.hotspotCandidates).hasSize(1)
  }

  /**
   * Order matters: a missing interface also has zero candidates and an erased entry also has zero,
   * so blaming the bind first would hide both.
   */
  @Test
  fun `a missing interface outranks the collision and the bind`() {
    val diagnosis =
      diagnose(
        scopedOwner = null,
        published =
          listOf(hotspot, PublishedEntry("rmnet_data0", "CONNECTION_4G", 0L, listOf("10.48.51.7"))),
      )

    assertThat(diagnosis.fault).isEqualTo(SoftApIceDiagnosis.Fault.MISSING_INTERFACE)
  }

  /** The analyzer reads these names, so they are a contract rather than log prose. */
  @Test
  fun `the fields carry every observation the analyzer reads`() {
    val fields = diagnose(candidates = listOf(offHotspot())).fields().toMap()

    assertThat(fields["code"]).isEqualTo(SoftApIceDiagnosis.CODE_ONLY_NON_HOTSPOT)
    assertThat(fields["fault"]).isEqualTo("WRONG_ADDRESS")
    assertThat(fields["scopedAddress"]).isEqualTo("192.168.43.79")
    assertThat(fields["scopedOwner"]).isEqualTo("wlan0")
    assertThat(fields["scopedInTable"]).isEqualTo(true)
    assertThat(fields["scopedPrefix"]).isEqualTo("192.168.43.79/24")
    assertThat(fields["publishedInventory"]).isEqualTo("wlan0[CONNECTION_WIFI]#0(192.168.43.79)")
    assertThat(fields["publishedHotspot"]).isEqualTo(true)
    assertThat(fields["handleCollision"]).isEqualTo(false)
    assertThat(fields["gathered"]).isEqualTo(1)
    assertThat(fields["hotspotCandidates"]).isEqualTo(0)
    assertThat(fields["offHotspot"]).isEqualTo("10.48.51.7@rmnet_data0")
  }

  @Test
  fun `an unattributable candidate address is reported as absent rather than dropped`() {
    val fields = diagnose(candidates = listOf(offHotspot(owner = null))).fields().toMap()

    assertThat(fields["offHotspot"]).isEqualTo("10.48.51.7@ABSENT")
  }

  @Test
  fun `an empty inventory reads as none rather than blank`() {
    val fields = diagnose(published = emptyList()).fields().toMap()

    assertThat(fields["publishedInventory"]).isEqualTo("none")
    assertThat(fields["offHotspot"]).isEqualTo("none")
  }
}
