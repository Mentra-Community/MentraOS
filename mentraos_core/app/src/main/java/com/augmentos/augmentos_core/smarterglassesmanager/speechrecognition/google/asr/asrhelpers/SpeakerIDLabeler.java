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
package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers;

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.SampleProcessorInterface;
import com.google.audio.SpeakerIdInfo;

import org.joda.time.Instant;

/**
 * An interface for classes that estimates labels for individual speakers.
 */
public interface SpeakerIDLabeler extends SampleProcessorInterface {
  /**
   * Tells the diarizer what time it is *now*. The expectation is that time will be incremented
   * within the calls to processAudioBytes based on the number of samples that are passed.
   */
  void setReferenceTimestamp(Instant now);

  /**
   * Asks the diarizer which speaker was most likely to be active during the time interval (start,
   * end). The same request may be made several times for the same interval, so this function should
   * be very inexpensive.
   */
  SpeakerIdInfo getSpeakerIDForTimeInterval(Instant start, Instant end);

  /**
   * Clears the labels currently stored in the diarizer. It is useful to periodically clear the
   * labels (such as at the start of every new utterance) in order to keep small the data structure
   * that holds the diarization timestamps.
   */
  void clearSpeakerIDTimestamps();

  /** Resets the state of the diarizer as if no audio has been seen. */
  void reset();
}
