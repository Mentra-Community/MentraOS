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

import com.google.audio.asr.TranscriptionResult;

/** An interface for communicating recognition events to the RepeatingRecognitionSession. */
public interface SpeechSessionListener {
  /**
   * Tells the client that the recognizer has had an error from which we cannot recover. It is safe
   * to terminate the session.
   */
  void onSessionFatalError(int sessionID, Throwable error);

  /**
   * Notifies that a new transcription result is available. If resultIsFinal is false, the results
   * are subject to change.
   */
  void onResults(int sessionID, TranscriptionResult result, boolean resultIsFinal);

  /** Signals that no more audio should be sent to the recognizer. */
  void onDoneListening(int sessionID);

  /**
   * Notifies that it is safe to kill the session. Called when the recognizer is done returning
   * results.
   */
  void onOkToTerminateSession(int sessionID);
}
