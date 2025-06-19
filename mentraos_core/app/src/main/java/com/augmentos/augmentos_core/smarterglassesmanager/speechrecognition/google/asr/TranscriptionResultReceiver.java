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

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.RepeatingRecognitionSession;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.RequestForRecognitionThread;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SpeechSessionListener;
import com.google.audio.asr.TranscriptionResult;
import com.google.common.base.Objects;
import com.google.common.flogger.FluentLogger;

import java.lang.ref.WeakReference;

/**
 * Handles results as they come in from the recognition module and posts them back to the
 * RepeatingRecognitionSession.
 */
class TranscriptionResultReceiver implements SpeechSessionListener {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();

  private final WeakReference<RepeatingRecognitionSession.PostHandler> postHandlerRef;

  public TranscriptionResultReceiver(RepeatingRecognitionSession.PostHandler postHandler) {
    this.postHandlerRef = new WeakReference<>(postHandler);
  }

  @Override
  public void onSessionFatalError(int sessionID, Throwable error) {
    logger.atSevere().withCause(error).log("Session #%d ended fatally.", sessionID);
    post(
        RequestForRecognitionThread.newBuilder()
            .setAction(
                errorIndicatesLossOfConnection(error)
                    ? RequestForRecognitionThread.Action.HANDLE_NETWORK_CONNECTION_FATAL_ERROR
                    : RequestForRecognitionThread.Action.HANDLE_NON_NETWORK_CONNECTION_FATAL_ERROR)
            .setSessionID(sessionID)
            .setErrorCause(error)
            .build());
  }

  @Override
  public void onResults(int sessionID, TranscriptionResult result, boolean resultsAreFinal) {
    post(
        RequestForRecognitionThread.newBuilder()
            .setSessionID(sessionID)
            .setAction(RequestForRecognitionThread.Action.POST_RESULTS)
            .setResult(result, resultsAreFinal)
            .build());
  }

  @Override
  public void onDoneListening(int sessionID) {
    logger.atInfo().log("Session #%d scheduled to be ended gracefully.", sessionID);
    post(sessionID, RequestForRecognitionThread.Action.REQUEST_TO_END_SESSION);
  }

  @Override
  public void onOkToTerminateSession(int sessionID) {
    logger.atInfo().log("Session #%d scheduled to be terminated.", sessionID);
    post(sessionID, RequestForRecognitionThread.Action.OK_TO_TERMINATE_SESSION);
  }

  private boolean errorIndicatesLossOfConnection(Throwable error) {
    boolean isGrpcError = error instanceof io.grpc.StatusRuntimeException;
    if (isGrpcError) {
      return Objects.equal(io.grpc.Status.fromThrowable(error), io.grpc.Status.UNAVAILABLE);
    }
    return false;
  }

  private void post(int sessionID, RequestForRecognitionThread.Action request) {
    post(
        RequestForRecognitionThread.newBuilder()
            .setAction(request)
            .setSessionID(sessionID)
            .build());
  }

  private void post(RequestForRecognitionThread request) {
    RepeatingRecognitionSession.PostHandler postHandler = postHandlerRef.get();
    if (postHandler == null) {
      return;
    }
    postHandler.post(request);
  }
}
