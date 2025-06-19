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

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.SampleProcessorInterface;

/**
 * Decides whether audio should be passed to the recognizer. Unlike the SpeechDetector, this
 * is not trying to make a fine-grain estimate about whether there is speech or not, but instead
 * it decides how to manage sessions, possibly based on the output of a SpeechDetector.
 */
public interface SpeechDetectionPolicy extends SampleProcessorInterface {
  boolean shouldPassAudioToRecognizer();

  void reset();

  /**
   * Tells the detector that there is currently evidence of speech coming from a source that is
   * external to this class (for example, getting transcription results from an ASR engine).
   *
   * <p>Use of this function is certainly not required (implementations may ignore these cues by not
   * overriding this function), but it can be used to build speech detectors that consume less power
   * when there is external evidence of speech.
   */
  default void cueEvidenceOfSpeech() {};
}

