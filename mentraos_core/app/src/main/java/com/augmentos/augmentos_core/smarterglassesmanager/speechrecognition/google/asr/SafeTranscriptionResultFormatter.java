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

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.TranscriptionResultFormatter;
import com.google.audio.asr.TranscriptionResult;
import com.google.audio.asr.TranscriptionResultFormatterOptions;
import com.google.common.flogger.FluentLogger;
import com.google.common.util.concurrent.SettableFuture;

import org.joda.time.Duration;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import javax.annotation.concurrent.GuardedBy;

/**
 * A thread-safe version of the TranscriptionResultFormatter. Please see
 * TranscriptionResultFormatter.java for notes on how to use the class.
 *
 * <p>Concurrency notes: These functions may be called from any thread. Note that the delay
 * corresponding to any particular function call depends on the length of the request queue.
 *
 * <p>This class implements a confined thread concurrency model where an internal service,
 * TranscriptionResultFormatterService, delegates requests to an instance of
 * TranscriptResultFormatter in an isolated thread. The thread remains open as long as there is work
 * to be done. If the work queue empties, the thread will close and a new one will spawn on the next
 * work request.
 */
public class SafeTranscriptionResultFormatter {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();

  private final TranscriptionResultFormatterService service;

  /** Protects the member, confinedThread, when the worker thread is being restarted. */
  private final Object threadRestartLock = new Object();
  @GuardedBy("threadRestartLock")
  private Thread confinedThread;

  /**
   * A request is a single job to be executed on the worker thread, confinedThread. Its members
   * represent the various inputs/outputs of the TranscriptionResultFormatter.
   */
  private static class Request {
    // Each of these elements is only used for a subset of requests.
    public TranscriptionResultFormatterOptions inOptions;
    public TranscriptionResult inTranscriptionResult;
    public final SettableFuture<Boolean> outBoolean;
    public final SettableFuture<Spanned> outSpanned;
    public final SettableFuture<Duration> outDuration;

    private final RequestType type;

    public Request(RequestType type) {
      this.type = type;
      outBoolean = SettableFuture.create();
      outSpanned = SettableFuture.create();
      outDuration = SettableFuture.create();
    }
  }

  // Used to pass requests to TranscriptionResultFormatterService.
  private final BlockingQueue<Request> requestQueue = new ArrayBlockingQueue<>(100);

  private enum RequestType {
    SET_OPTIONS,
    RESET,
    ADD_FINALIZED_RESULT,
    CLEAR_CURRENT_HYPOTHESIS,
    FINALIZE_CURRENT_HYPOTHESIS,
    SET_CURRENT_HYPOTHESIS,
    GET_FORMATTED_TRANSCRIPT,
    GET_MOST_RECENT_TRANSCRIPT_SEGMENT,
    GET_TRANSCRIPT_DURATION,
  }

  private static final String EXECUTION_EXCEPTION_MESSAGE = "request failed.";
  private static final String INTERRUPTED_EXCEPTION_MESSAGE = "was interrupted.";

  public SafeTranscriptionResultFormatter() {
    this.service = new TranscriptionResultFormatterService();
  }

  public SafeTranscriptionResultFormatter(TranscriptionResultFormatterOptions options) {
    this.service = new TranscriptionResultFormatterService(options);
  }

  private void ensureThreadIsRunning() {
    synchronized (threadRestartLock) {
      if (confinedThread == null) {
        logger.atInfo().log("Restarting formatter request queue. %s", confinedThread);
        confinedThread = new Thread(service, "SafeTranscriptionResultFormatter_confinedThread");
        confinedThread.start();
      }
    }
  }

  public void setOptions(TranscriptionResultFormatterOptions options) {
    try {
      Request request = new Request(RequestType.SET_OPTIONS);
      request.inOptions = options;
      requestQueue.put(request);
      ensureThreadIsRunning();
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log("setOptions %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
  }

  public void reset() {
    try {
      requestQueue.put(new Request(RequestType.RESET));
      ensureThreadIsRunning();
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log("reset %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
  }

  public void addFinalizedResult(TranscriptionResult resultSingleUtterance) {
    try {
      Request request = new Request(RequestType.ADD_FINALIZED_RESULT);
      request.inTranscriptionResult = resultSingleUtterance;
      requestQueue.put(request);
      ensureThreadIsRunning();
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "addFinalizedResult %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
  }

  public void clearCurrentHypothesis() {
    try {
      requestQueue.put(new Request(RequestType.CLEAR_CURRENT_HYPOTHESIS));
      ensureThreadIsRunning();
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "clearCurrentHypothesis %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
  }

  public boolean finalizeCurrentHypothesis() {
    try {
      Request request = new Request(RequestType.FINALIZE_CURRENT_HYPOTHESIS);
      requestQueue.put(request);
      ensureThreadIsRunning();
      return request.outBoolean.get();
    } catch (ExecutionException error) {
      logger.atSevere().withCause(error).log(
          "finalizeCurrentHypothesis %s", EXECUTION_EXCEPTION_MESSAGE);
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "finalizeCurrentHypothesis %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
    return false;
  }

  public void setCurrentHypothesis(TranscriptionResult resultSingleUtterance) {
    try {
      Request request = new Request(RequestType.SET_CURRENT_HYPOTHESIS);
      request.inTranscriptionResult = resultSingleUtterance;
      requestQueue.put(request);
      ensureThreadIsRunning();
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "setCurrentHypothesis %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
  }

  public Spanned getFormattedTranscript() {
    try {
      Request request = new Request(RequestType.GET_FORMATTED_TRANSCRIPT);
      requestQueue.put(request);
      ensureThreadIsRunning();
      return request.outSpanned.get();
    } catch (ExecutionException error) {
      logger.atSevere().withCause(error).log(
          "getFormattedTranscript %s", EXECUTION_EXCEPTION_MESSAGE);
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "getFormattedTranscript %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
    return null;
  }

  public Spanned getMostRecentTranscriptSegment() {
    try {
      Request request = new Request(RequestType.GET_MOST_RECENT_TRANSCRIPT_SEGMENT);
      requestQueue.put(request);
      ensureThreadIsRunning();
      return request.outSpanned.get();
    } catch (ExecutionException error) {
      logger.atSevere().withCause(error).log(
          "getMostRecentTranscriptSegment %s", EXECUTION_EXCEPTION_MESSAGE);
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "getMostRecentTranscriptSegment %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
    return null;
  }

  public Duration getTranscriptDuration() {
    try {
      Request request = new Request(RequestType.GET_TRANSCRIPT_DURATION);
      requestQueue.put(request);
      ensureThreadIsRunning();
      return request.outDuration.get();
    } catch (ExecutionException error) {
      logger.atSevere().withCause(error).log(
          "getTranscriptDuration %s", EXECUTION_EXCEPTION_MESSAGE);
    } catch (InterruptedException interrupted) {
      logger.atSevere().withCause(interrupted).log(
          "getTranscriptDuration %s", INTERRUPTED_EXCEPTION_MESSAGE);
    }
    return null;
  }

  /**
   * A service to be run on a separate thread that performs the formatting logic. The formatting
   * logic is controlled by the TranscriptionResultFormatter instance (which is not thread-safe).
   * Each job is sent to this class by adding a request into requestQueue. Jobs will be executed in
   * the order that they are placed in the queue.
   *
   * <p>If the queue remains empty for longer than 15 seconds, the run() method will complete and
   * the parent thread will end. However, it may be restarted in a new thread.
   */
  private class TranscriptionResultFormatterService implements Runnable {
    private final TranscriptionResultFormatter impl;

    TranscriptionResultFormatterService() {
      impl = new TranscriptionResultFormatter();
    }

    TranscriptionResultFormatterService(TranscriptionResultFormatterOptions options) {
      impl = new TranscriptionResultFormatter(options);
    }

    // Concurrency notes: As long as this task does not make callbacks into client code or
    // spawn additional tasks, there is no risk of it deadlocking. Be very careful in modifying it.

    @Override
    public void run() {
      Thread.currentThread().setName("SafeTranscriptionResultFormatterThread");
      try {
        while (true) {
          // Try and pull from the queue. If the queue is empty for more than 15 seconds, complete
          // the thread. The parent class will start a new thread to process this service again if
          // another task arrives.
          Request request = requestQueue.poll(15, TimeUnit.SECONDS);
          if (request == null) {
            // We are ready to terminate the thread.
            synchronized (threadRestartLock) {
//              logger.atInfo().log("Formatter request queue is exhausted. %s", confinedThread);
              // Setting confinedThread to null is very important. This is how we signal in a
              // synchronizable way that this thread is no longer relevant. The parent object
              // can restart a new thread if more requests come in.
              confinedThread = null;
            }
            return;
          }
          switch (request.type) {
            case SET_OPTIONS:
              impl.setOptions(request.inOptions);
              break;
            case RESET:
              impl.reset();
              break;
            case ADD_FINALIZED_RESULT:
              impl.addFinalizedResult(request.inTranscriptionResult);
              break;
            case CLEAR_CURRENT_HYPOTHESIS:
              impl.clearCurrentHypothesis();
              break;
            case FINALIZE_CURRENT_HYPOTHESIS:
              request.outBoolean.set(impl.finalizeCurrentHypothesis());
              break;
            case SET_CURRENT_HYPOTHESIS:
              impl.setCurrentHypothesis(request.inTranscriptionResult);
              break;
            case GET_FORMATTED_TRANSCRIPT:
              request.outSpanned.set(impl.getFormattedTranscript());
              break;
            case GET_MOST_RECENT_TRANSCRIPT_SEGMENT:
              request.outSpanned.set(impl.getMostRecentTranscriptSegment());
              break;
            case GET_TRANSCRIPT_DURATION:
              request.outDuration.set(impl.getTranscriptDuration());
              break;
          }
        }
      } catch (InterruptedException interrupted) {
        // Interrupting causes the service to stop.
        logger.atSevere().withCause(interrupted).log("Formatter service has been interrupted");
      }
    }
  }
}
