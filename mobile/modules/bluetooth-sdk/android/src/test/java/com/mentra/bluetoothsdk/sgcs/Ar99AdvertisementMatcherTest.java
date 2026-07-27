package com.mentra.bluetoothsdk.sgcs;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class Ar99AdvertisementMatcherTest {

  @Test
  public void supportsOnlyDocumentedProjectIdentifiers() {
    assertThat(Ar99.isSupportedProjectName("AR99")).isTrue();
    assertThat(Ar99.isSupportedProjectName("ar99")).isTrue();

    assertThat(Ar99.isSupportedProjectName("AF98")).isFalse();
    assertThat(Ar99.isSupportedProjectName("AF99")).isFalse();
    assertThat(Ar99.isSupportedProjectName("HVXM")).isFalse();
    assertThat(Ar99.isSupportedProjectName("HVXF")).isFalse();
    assertThat(Ar99.isSupportedProjectName("AR99X")).isFalse();
    assertThat(Ar99.isSupportedProjectName("")).isFalse();
    assertThat(Ar99.isSupportedProjectName(null)).isFalse();
  }
}
