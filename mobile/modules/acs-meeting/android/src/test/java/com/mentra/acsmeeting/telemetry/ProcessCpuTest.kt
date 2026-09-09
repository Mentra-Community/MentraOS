package com.mentra.acsmeeting.telemetry

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ProcessCpuTest {
  @Test
  fun percentMatchesTopStyleOverOneSecond() {
    assertThat(ProcessCpu.percent(cpuDeltaMs = 1120, wallDeltaMs = 1000)).isEqualTo(112.0)
    assertThat(ProcessCpu.percent(cpuDeltaMs = 200, wallDeltaMs = 1000)).isEqualTo(20.0)
  }

  @Test
  fun labelFormatsNaUntilFirstSample() {
    assertThat(ProcessCpu.label(null, 8)).isEqualTo("cpu{proc=na cores=8}")
    assertThat(ProcessCpu.label(112.4, 8)).isEqualTo("cpu{proc=112.4 cores=8}")
  }
}
