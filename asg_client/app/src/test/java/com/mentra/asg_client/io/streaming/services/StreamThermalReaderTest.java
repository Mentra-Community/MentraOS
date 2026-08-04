package com.mentra.asg_client.io.streaming.services;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;

public class StreamThermalReaderTest {
    @Test
    public void normalizeCelsius_acceptsMillidegrees() {
        assertThat(StreamThermalReader.normalizeCelsius("54600")).isEqualTo(54.6d);
    }

    @Test
    public void normalizeCelsius_acceptsDegrees() {
        assertThat(StreamThermalReader.normalizeCelsius("54.6")).isEqualTo(54.6d);
    }

    @Test
    public void normalizeCelsius_rejectsInvalidSensorValues() {
        assertThat(StreamThermalReader.normalizeCelsius("0")).isNaN();
        assertThat(StreamThermalReader.normalizeCelsius("250000")).isNaN();
    }
}
