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

import static com.google.common.base.Preconditions.checkArgument;

import com.google.audio.asr.TranscriptionResult;

/**
 * Actions that may be performed on the session that should be executed in the recognition thread.
 *
 * <p>Most requests come from a session, but they can also come from a client triggering a reset or
 * a model change. If the request comes from a session, it will be marked with a session ID.
 */
public class RequestForRecognitionThread {
  private static final int NO_SESSION = -1;
  private final Action action;
  private final TranscriptionResult result;
  private final boolean requestIsFinal;
  private final int sessionID;
  private final Throwable errorCause;

  /** The action that will be executed on the audio thread of the RepeatingRecognitionSession. */
  public enum Action {
    NO_ACTION,
    HANDLE_NETWORK_CONNECTION_FATAL_ERROR,
    HANDLE_NON_NETWORK_CONNECTION_FATAL_ERROR,
    OK_TO_TERMINATE_SESSION,
    POST_RESULTS,
    REQUEST_TO_END_SESSION,
    RESET_SESSION,
    RESET_SESSION_AND_CLEAR_TRANSCRIPT,
  }

  private RequestForRecognitionThread(Builder builder) {
    this.action = builder.action;
    this.result = builder.result;
    this.requestIsFinal = builder.requestIsFinal;
    this.sessionID = builder.sessionID;
    this.errorCause = builder.errorCause;
  }

  static Builder newBuilder() {
    return new Builder();
  }

  Action action() {
    return action;
  }

  boolean hasSessionID() {
    return sessionID != NO_SESSION;
  }

  // May return NO_SESSION.
  int sessionID() {
    return sessionID;
  }

  boolean requestIsFinal() {
    return requestIsFinal;
  }

  TranscriptionResult result() {
    return result;
  }

  Throwable getErrorCause() {
    return errorCause;
  }

  /** A Builder class for RequestForRecognitionThread objects. */
  static class Builder {
    private Action action = Action.NO_ACTION;
    private int sessionID = NO_SESSION;
    private TranscriptionResult result = null;
    private boolean requestIsFinal;
    private Throwable errorCause = null;

    private Builder() {}

    /** Notes the action to be performed. If you don't call this, no action will be requested. */
    public Builder setAction(Action action) {
      this.action = action;
      return this;
    }

    /** Tells the audio thread what the corresponding session ID is. Must be non-negative. */
    public Builder setSessionID(int sessionID) {
      // We use a negative value to indicate NO_SESSION. Do not assign a negative ID.
      checkArgument(sessionID >= 0);
      this.sessionID = sessionID;
      return this;
    }

    /** Adds a finalized/nonfinalized result to the request. */
    public Builder setResult(TranscriptionResult result, boolean requestIsFinal) {
      this.result = result;
      this.requestIsFinal = requestIsFinal;
      return this;
    }

    public RequestForRecognitionThread build() {
      return new RequestForRecognitionThread(this);
    }

    public Builder setErrorCause(Throwable errorCause) {
      this.errorCause = errorCause;
      return this;
    }
  }
}
