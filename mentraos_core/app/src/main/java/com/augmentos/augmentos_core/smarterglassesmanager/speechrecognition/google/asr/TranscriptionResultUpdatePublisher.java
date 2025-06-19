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

import android.text.Spanned;

/** An interface for notifying the most recent transcription comes from the recognizer. */
public interface TranscriptionResultUpdatePublisher {
  /** A notification about the nature of the update. */
  enum UpdateType {
    TRANSCRIPT_UPDATED,
    TRANSCRIPT_FINALIZED,
    TRANSCRIPT_CLEARED,
  }

  /** Enum defining kinds of transcript result the listeners expect to handle. */
  enum ResultSource {
    /** Provides the most recent transcript result in current session. */
    MOST_RECENT_SEGMENT,
    /** Provides the whole transcript result in current session. */
    WHOLE_RESULT
  }

  /**
   * Called when transcription updates from the server.
   *
   * @param formattedResult The formatted result for the transcription.
   * @param updateType The nature of the update.
   */
  void onTranscriptionUpdate(Spanned formattedResult, UpdateType updateType);
}
