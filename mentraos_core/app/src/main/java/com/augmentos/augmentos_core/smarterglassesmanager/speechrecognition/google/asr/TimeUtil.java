/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr;

import com.google.protobuf.Timestamp;
import com.google.protobuf.util.Durations;
import com.google.protobuf.util.Timestamps;

import org.joda.time.Duration;
import org.joda.time.Instant;

/**
 * Conversions between the proto and Joda timestamp representations.
 *
 * <p>Note that toInstant() drops from nanosecond to millisecond precision (which shouldn't be
 * needed for ASR applications anyhow).
 */
public final class TimeUtil {
  public static Instant toInstant(Timestamp t) {
    return new Instant(Timestamps.toMillis(t));
  }

  public static Timestamp toTimestamp(Instant t) {
    return Timestamps.fromMillis(t.getMillis());
  }

  public static Duration convert(com.google.protobuf.Duration d) {
    return Duration.millis(Durations.toMillis(d));
  }

  public static com.google.protobuf.Duration convert(Duration d) {
    return Durations.fromMillis(d.getMillis());
  }
  private TimeUtil() {}
}
