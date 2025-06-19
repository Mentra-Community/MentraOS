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

import com.google.audio.SpeakerIdInfo;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.SpeakerIDLabeler;

import org.joda.time.Instant;

/** A diarizer that always reports the same speaker. */
public class AlwaysSameSpeakerIDLabeler implements SpeakerIDLabeler {
  private final SpeakerIdInfo fixedInfo;

  public AlwaysSameSpeakerIDLabeler(SpeakerIdInfo fixedInfo) {
    this.fixedInfo = fixedInfo;
  }

  @Override
  public void setReferenceTimestamp(Instant now) {}

  @Override
  public SpeakerIdInfo getSpeakerIDForTimeInterval(Instant start, Instant end) {
    return fixedInfo;
  }

  @Override
  public void init(int blockSizeSamples) {}

  @Override
  public void clearSpeakerIDTimestamps() {}

  @Override
  public void reset() {}

  @Override
  public void processAudioBytes(byte[] bytes, int offset, int length) {}

  @Override
  public void stop() {}
}
