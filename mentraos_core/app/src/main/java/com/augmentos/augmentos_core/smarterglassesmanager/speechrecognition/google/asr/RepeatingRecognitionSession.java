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
import static com.google.common.base.Preconditions.checkNotNull;

import android.text.Spanned;

import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.AlwaysSameSpeakerIDLabeler;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.AlwaysSpeechPolicy;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.RequestForRecognitionThread;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SafeTranscriptionResultFormatter;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SpeechDetectionPolicy;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SpeechSession;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SpeechSessionFactory;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.SpeechSessionListener;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.TimeUtil;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.TranscriptionErrorPublisher;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.TranscriptionResultUpdatePublisher;
import com.google.audio.SpeakerIdInfo;
import com.google.audio.asr.SpeechRecognitionModelOptions;
import com.google.audio.asr.TranscriptionResult;
import com.google.common.base.Optional;
import com.google.common.flogger.FluentLogger;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.CircularByteBuffer;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.NetworkConnectionChecker;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.SampleProcessorInterface;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.google.asr.asrhelpers.SpeakerIDLabeler;

import org.joda.time.Duration;
import org.joda.time.Instant;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * Repeatedly runs recognition sessions, starting a new session whenever one terminates, until
 * stopped.
 *
 * <p>Incoming is speech is timestamped as time since epoch in milliseconds.
 *
 * <p>In between sessions, some buffering is done, but if the internal session is closed for more
 * than SECONDS_TO_STORE_BETWEEN_SESSIONS, audio will be lost.
 *
 * <p>This class was intended to be used from a thread where timing is not critical (i.e. do not
 * call this in a system audio callback). Network calls may be made during all of the functions
 * inherited from SampleProcessorInterface.
 *
 * <p>Results delivered via a TranscriptionResultUpdatePublisher are done so asynchronously. All
 * public functions that are not a part of the SampleProcessorInterface API may be called from any
 * thread at any time.
 *
 * <p>TranscriptionResultUpdatePublisher callbacks are delivered from a thread on a separate thread
 * pool. You will never get two callbacks to the same TranscriptionResultUpdatePublisher instance at
 * the same time.
 */

// Threading notes:
//
// Recognition thread:
// This thread is owned by whatever system is providing the class with audio (one that treats this
// generically as a SampleProcessorInterface, interacting only with the init(), processAudioBytes(),
// and stop() methods). This is the thread that is doing most of the work of the class (session
// management, audio buffering and processing, network checks, etc.). Be aware that it can make
// network calls and do other expensive actions that should not be placed in a system audio
// callback.
//
// Note that your audio engine should never call init(), processAudioBytes(), and stop()
// concurrently.
//
// Results thread:
// This thread is not exposed outside of this class. It is controlled by the CloudSpeechSession and
// alerts the TranscriptionResultReceiver when the recognition has a result from the server. It
// posts requests to the recognition thread via that 'requests' member below. If the speech session
// implementation is single threaded, this thread and the recognition thread are the same thread.
//
// Other threads:
// Public methods other than init(), processAudioBytes(), and stop() may be called from threads
// other than the recognition thread. They are thread-safe.

public class RepeatingRecognitionSession implements SampleProcessorInterface {
  /* ---------------- BEGIN: MEMBERS THAT ARE SHARED ACROSS MULTIPLE THREADS ------------------ */
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();

  // All threads but the recognition thread may post to this queue, only the recognition thread
  // will read from it.
  private final ConcurrentLinkedQueue<RequestForRecognitionThread> requests =
      new ConcurrentLinkedQueue<>();

  // Shared between client threads and recognizer thread.
  private final AtomicBoolean repeatedSessionIsInitialized = new AtomicBoolean(false);
  private final AtomicReference<SpeechRecognitionModelOptions> modelOptions =
      new AtomicReference<>();
  private final ConcurrentLinkedQueue<TranscriptionResultPublisherReference> callbackRefs;
  private final TranscriptionErrorPublisher transcriptionErrorPublisher;
  // The client may have retained a reference to the formatter, so it is assumed to be accessible
  // from multiple threads. However, it is a thread-safe object.
  private final SafeTranscriptionResultFormatter resultFormatter;
  /* ----------------- END: MEMBERS THAT ARE SHARED ACROSS MULTIPLE THREADS ------------------- */

  /* --------------- BEGIN: MEMBERS THAT ARE ACCESSED ONLY FROM RESULTS THREAD ---------------- */
  /** An interface for posting requests to the RepeatingRecognitionSession. */
  public interface PostHandler {
    void post(RequestForRecognitionThread request);
  }

  private final PostHandler postHandler;
  private final SpeechSessionListener speechSessionListener;
  /* ---------------- END: MEMBERS THAT ARE ACCESSED ONLY FROM RESULTS THREAD ----------------- */

  /* ------------- BEGIN: MEMBERS THAT ARE ACCESSED ONLY FROM RECOGNITION THREAD -------------- */
  /**
   * Used to keep track of the current session. This is not only used for numbering incoming
   * sessions, but also to prevent old sessions from updating the state of this object. Old sessions
   * may persist and send results back to RepeatingRecognitionSession after a call to reset() or
   * after stop() and init() are called in quick succession. Sessions IDs will be monotonically
   * increasing, but are not guaranteed to be contiguous.
   */
  private int currentSessionID = -1;

  public static final Duration SECONDS_TO_STORE_BETWEEN_SESSIONS = Duration.standardSeconds(10);
  private static final int BYTES_PER_SAMPLE = 2;

  // Members related to session management.
  private SpeechSession currentSession;
  private final SpeechSessionFactory sessionFactory;
  private final int sampleRateHz;
  private int chunkSizeSamples;

  private boolean isStopped = false;
  private boolean okToTerminateSession = false;

  // Some variables to facilitate buffering between sessions.
  private static int maxNumSamplesToStoreBetweenSessions;
  private CircularByteBuffer leftoverBytes;
  private byte[] leftoverBytesAllocation; // Exists to avoid repeated allocations.
  private CircularByteBuffer.Reader leftoverBytesReader;

  /**
   * Allows the RepeatingRecognitionSession to stall session creation when there is a network error
   * until connection is regained. If not provided, a short delay will happen after connection loss
   * to prevent a rapid recreation of sessions.
   */
  private final NetworkConnectionChecker networkCheck;

  private boolean hadNetworkConnectionError = false;
  private Instant lastInitSessionTimestampWithoutNetworkChecker = new Instant(0);
  static final Duration RECREATE_SESSION_IF_NO_NETWORKCHECKER_DURATION =
      Duration.standardSeconds(1);

  private final SpeechDetectionPolicy speechDetector;
  private final SpeakerIDLabeler diarizer;

  /** Passes results back to registered listeners. */
  private final ExecutorService resultsDeliveryService;

  /**
   * Keeps track of time that the last session ended. This will be used to log how long reconnection
   * takes.
   */
  private Optional<Instant> endSessionRequestTime = Optional.absent();
  /* -------------- END: MEMBERS THAT ARE ACCESSED ONLY FROM RECOGNITION THREAD --------------- */

  /*
   * A specialized reference for {@link TranscriptionResultUpdatePublisher} that allows us to fix
   * the {@link TranscriptionResultUpdatePublisher.ResultSource} which the callback expect to
   * handle.
   */
  private static class TranscriptionResultPublisherReference
      extends WeakReference<TranscriptionResultUpdatePublisher> {
    final TranscriptionResultUpdatePublisher.ResultSource source;

    public TranscriptionResultPublisherReference(
        TranscriptionResultUpdatePublisher referent,
        TranscriptionResultUpdatePublisher.ResultSource source) {
      super(referent);
      this.source = source;
    }
  }

  private RepeatingRecognitionSession(Builder builder) {
    this.postHandler = (request) -> requests.add(request);
    this.speechSessionListener = new TranscriptionResultReceiver(postHandler);
    this.resultFormatter = builder.resultFormatter;
    this.sampleRateHz = builder.sampleRateHz;
    this.sessionFactory = builder.sessionFactory;
    this.modelOptions.set(builder.modelOptions);
    this.networkCheck = builder.networkCheck;
    this.speechDetector = builder.speechDetector;
    this.diarizer = builder.diarizer;
    this.callbackRefs = builder.callbackRefs;
    this.resultsDeliveryService = builder.resultsDeliveryService;
    this.transcriptionErrorPublisher = builder.transcriptionErrorPublisher;

    maxNumSamplesToStoreBetweenSessions =
        (int) Math.ceil(SECONDS_TO_STORE_BETWEEN_SESSIONS.getStandardSeconds() * sampleRateHz);
  }

  public static Builder newBuilder() {
    return new Builder();
  }

  // Should only be called on the recognition thread. See threading notes above.
  @Override
  public void init(int chunkSizeSamples) {
    checkArgument(chunkSizeSamples > 0);
    this.chunkSizeSamples = chunkSizeSamples;
    speechDetector.init(chunkSizeSamples);
    diarizer.init(chunkSizeSamples);
    diarizer.setReferenceTimestamp(Instant.now());
    this.leftoverBytes =
        new CircularByteBuffer(maxNumSamplesToStoreBetweenSessions * BYTES_PER_SAMPLE);
    this.leftoverBytesAllocation = new byte[leftoverBytes.getCapacity()];
    this.leftoverBytesReader = leftoverBytes.newReader();
    isStopped = false;
    okToTerminateSession = false;
    // Create the first session.
    currentSession = sessionFactory.create(speechSessionListener, sampleRateHz);
    repeatedSessionIsInitialized.set(true);
  }

  // Should only be called on the recognition thread. See threading notes above.
  @Override
  public void processAudioBytes(byte[] samples, int offset, int length) {
    if (!repeatedSessionIsInitialized.get()) {
      throw new IllegalStateException("processAudioBytes() called prior to initialization!");
    }
    if (isStopped) {
      throw new IllegalStateException("processAudioBytes() called while stopped!");
    }
    // Ignoring thread safety issues, it would be ideal to run handlePostedActions() endlessly in
    // another thread. To keep everything on the same thread, we run it in this function first
    // at the beginning to process reset events as soon as possible and again at the end to process
    // results as soon as their generated (in practice, this is mostly useful during testing).
    handlePostedActions();
    speechDetector.processAudioBytes(samples, offset, length);
    diarizer.processAudioBytes(samples, offset, length);

    // Restart the session when necessary.
    if (okToTerminateSession) {
      logger.atInfo().log(
          "Creating a new session. Reconnection timer: %s", getReconnectionTimerValue());
      currentSession = sessionFactory.create(speechSessionListener, sampleRateHz);
      okToTerminateSession = false;
    }

    // If we need network, but it is unavailable, put the samples in leftovers.
    boolean networkRequirementsMet =
        !currentSession.requiresNetworkConnection() || isNetworkAvailable();
    if (!networkRequirementsMet) {
      storeSamplesInLeftovers(samples, offset, length, false);
      // Stop the session when network is lost.
      if (currentSession.isInitialized()) {
        logger.atInfo().log(
            "Online Session #%d abandoned due to lack of network connection.",
            currentSession.sessionID());
        requestCurrentSessionEnd();
      }
      return;
    }
    hadNetworkConnectionError = false;

    // If there is no speech, end the session, and don't try to process data.
    if (!speechDetector.shouldPassAudioToRecognizer()) {
      // Buffer the speech so that when we reconnect, even a late speech detection will cause some
      // of the buffered audio to get to the server. If we drop samples we don't need to log because
      // we know it does not contain speech.
      storeSamplesInLeftovers(samples, offset, length, true);
      if (currentSession.isInitialized()) {
//        logger.atInfo().log(
//            "Session #%d ending due to lack of detected speech.", currentSession.sessionID());
        requestCurrentSessionEnd();
      }
      return;
    }

    // Initialize the session.
    if (!currentSession.isInitialized()) {
      // Get the reference to the model so that the log and the session see the same version.
      SpeechRecognitionModelOptions model = modelOptions.get();
      currentSessionID++;
//      logger.atInfo().log(
//          "Starting a Session #%d in language `%s`.", currentSessionID, model.getLocale());
      currentSession.init(model, chunkSizeSamples, currentSessionID);
    }

    tryToProcessLeftovers();

    // If the session can take requests, send samples. Otherwise, put them into the leftover queue.
    if (currentSession.processAudioBytes(samples, offset, length)) {
      stopReconnectionTimer();
    } else {
      storeSamplesInLeftovers(samples, offset, length, false);
    }

    handlePostedActions();
  }

  /**
   * Terminate the current session. Any results from the server after a call to stop() are not
   * guaranteed to arrive.
   */
  // Should only be called only from the MicManager on the recognition thread as a
  // SampleProcessorInterface.
  @Override
  public void stop() {
    // Handle any requests that have happened prior to now.
    handlePostedActions();
    isStopped = true;
    speechDetector.stop();
    diarizer.stop();
    if (currentSession.isInitialized()) {
//      logger.atInfo().log(
//          "Session #%d abandoned due to repeated session ending.", currentSession.sessionID());
      abandonCurrentSession();
    }
    repeatedSessionIsInitialized.set(false);
  }

  /**
   * Restarts recognition, discarding the state of the currently active session. Request is
   * performed asynchronously, so this function may be called from any thread at any point during
   * the session.
   *
   * <p>Results generated after the asynchronous reset will not arrive.
   */
  // May be called from any thread.
  public void reset() {
    reset(false);
  }

  private void reset(boolean clearTranscript) {
    if (!repeatedSessionIsInitialized.get()) {
      return;
    }
//    logger.atInfo().log(
//        "Session #%d scheduled to be abandoned due to call to reset().",
//        currentSession.sessionID());
    requests.add(
        RequestForRecognitionThread.newBuilder()
            .setAction(
                clearTranscript
                    ? RequestForRecognitionThread.Action.RESET_SESSION_AND_CLEAR_TRANSCRIPT
                    : RequestForRecognitionThread.Action.RESET_SESSION)
            .build());
  }

  /**
   * Restarts recognition, discarding the state of the currently active session. Request is
   * performed asynchronously, so this function may be called from any thread at any point during
   * the session. Clears returned transcript. The caller will know that
   * the reset has been completed when a TRANSCRIPT_CLEARED is received through the listener.
   */
  // May be called from any thread.
  public void resetAndClearTranscript() {
    reset(true);
  }

  /**
   * Sets the modelOptions, which may include a language change or usage of a different model.
   * Session management is performed asynchronously, so this function may be called from any thread
   * at any point during the session.
   */
  // May be called from any thread.
  public void setModelOptions(SpeechRecognitionModelOptions modelOptions) {
    this.modelOptions.set(modelOptions);
//    logger.atInfo().log("Session scheduled to be ended due to model options change.");
    requests.add(
        RequestForRecognitionThread.newBuilder()
            .setAction(RequestForRecognitionThread.Action.REQUEST_TO_END_SESSION)
            .build());
  }

  /** Gets the modelOptions, which may include a language change or usage of a different model. */
  // May be called from any thread.
  public SpeechRecognitionModelOptions getModelOptions() {
    return modelOptions.get();
  }

  // Must be called prior to init() or after stop().
  public void registerCallback(
      TranscriptionResultUpdatePublisher callback,
      TranscriptionResultUpdatePublisher.ResultSource source) {
    checkNotNull(callback);
    Iterator<TranscriptionResultPublisherReference> iterator = callbackRefs.iterator();
    while (iterator.hasNext()) {
      if (callback.equals(iterator.next().get())) {
        throw new RuntimeException("Listener is already registered.");
      }
    }
    callbackRefs.add(new TranscriptionResultPublisherReference(callback, source));
  }

  // Must be called prior to init() or after stop().
  public void unregisterCallback(TranscriptionResultUpdatePublisher callback) {
    checkNotNull(callback);
    Iterator<TranscriptionResultPublisherReference> iterator = callbackRefs.iterator();
    while (iterator.hasNext()) {
      if (callback.equals(iterator.next().get())) {
        iterator.remove();
      }
    }
  }

  /**
   * Pulls requests off of the queue and performs them. This is only to be called from the thread
   * that is calling init(), processAudioBytes(), and stop().
   *
   * <p>Internal notes: None of the tasks performed while emptying the request queue should make a
   * call to handlePostedActions() or post new requests, as this may result in results being
   * processed out of order.
   */
  private void handlePostedActions() {
    RequestForRecognitionThread request = requests.poll();

    while (request != null) {
      if (request.hasSessionID() && request.sessionID() < currentSessionID) {
        // Completely ignore results for sessions that have been abandoned.
//        logger.atInfo().log("Old event from Session #%d discarded.", request.sessionID());
        request = requests.poll();
        continue;
      }
      switch (request.action()) {
        case HANDLE_NETWORK_CONNECTION_FATAL_ERROR:
//          logger.atInfo().log("Closing Session #%d due to network error.", request.sessionID());
          finalizeLeftoverHypothesis();
          okToTerminateSession = true;
          processError(request.getErrorCause());
          startReconnectionTimer();
          break;
        case HANDLE_NON_NETWORK_CONNECTION_FATAL_ERROR:
//          logger.atInfo().log("Closing Session #%d due to non-network error.", request.sessionID());
          hadNetworkConnectionError = true;
          finalizeLeftoverHypothesis();
          okToTerminateSession = true;
          processError(request.getErrorCause());
          startReconnectionTimer();
          break;
        case POST_RESULTS:
//          logger.atInfo().log(
//              "Session #%d received result (final = %b).",
//              request.sessionID(), request.requestIsFinal());
          processResult(request.result(), request.requestIsFinal());
          break;
        case OK_TO_TERMINATE_SESSION:
//          logger.atInfo().log("Terminating Session #%d cleanly.", request.sessionID());
          okToTerminateSession = true;
          startReconnectionTimer();
          break;
        case REQUEST_TO_END_SESSION:
          requestCurrentSessionEnd();
          break;
        case RESET_SESSION:
          resetInternal();
          break;
        case RESET_SESSION_AND_CLEAR_TRANSCRIPT:
          resetInternal();
          resultFormatter.reset();
          sendTranscriptResultUpdated(
              TranscriptionResultUpdatePublisher.UpdateType.TRANSCRIPT_CLEARED);
          break;
        case NO_ACTION:
          break;
      }
      request = requests.poll();
    }
  }

  private void processError(Throwable errorCause) {
    if (transcriptionErrorPublisher != null) {
      transcriptionErrorPublisher.onError(errorCause);
    }
  }

  private void resetInternal() {
    speechDetector.reset();
    if (currentSession.isInitialized()) {
//      logger.atInfo().log(
//          "Session #%d abandoned due to call to reset().", currentSession.sessionID());
      abandonCurrentSession();
    }
  }

  private void requestCurrentSessionEnd() {
    if (repeatedSessionIsInitialized.get() && currentSession.isInitialized()) {
      currentSession.requestCloseSession();
    }
  }

  private void abandonCurrentSession() {
    finalizeLeftoverHypothesis();
    requestCurrentSessionEnd();
    // By incrementing the session ID here, we are preventing results from the old session from
    // being processed.
    currentSessionID++;
    okToTerminateSession = true;
  }

  private void tryToProcessLeftovers() {
    // Process stored samples, if there are any.
    int numLeftoverBytes = leftoverBytesReader.availableBytes();
    if (numLeftoverBytes > 0) {
      leftoverBytesReader.peek(leftoverBytesAllocation, 0, numLeftoverBytes);
      if (currentSession.processAudioBytes(leftoverBytesAllocation, 0, numLeftoverBytes)) {
        stopReconnectionTimer();
        leftoverBytes.reset(); // Readers get reset.
      }
    }
  }

  private void storeSamplesInLeftovers(
      byte[] samples, int offset, int length, boolean droppingSamplesIsIntended) {
    // If we fail this, it means we passed many seconds of audio at once. This should never happen
    // under normal streaming conditions.
    checkArgument(length < leftoverBytes.getCapacity());
    int numLeftoverBytes = leftoverBytesReader.availableBytes();
    if (numLeftoverBytes + length > leftoverBytes.getCapacity()) {
      if (!droppingSamplesIsIntended) {
//        logger.atSevere().atMostEvery(5, TimeUnit.SECONDS).log(
//            "Dropped audio between sessions. [atMostEvery 5s]");
      }
      leftoverBytesReader.advance((numLeftoverBytes + length) - leftoverBytes.getCapacity());
    }
    leftoverBytes.write(samples, offset, length);
  }

  /**
   * Check reconnect timeout to prevent connecting fail repeatedly in a short time.
   *
   * @return true if establishing connection is allowed.
   */
  private boolean isNetworkReconnectionTimeout() {
    if (RECREATE_SESSION_IF_NO_NETWORKCHECKER_DURATION.isShorterThan(
        new Duration(lastInitSessionTimestampWithoutNetworkChecker, Instant.now()))) {
      // Allow to create a new session every second.
      lastInitSessionTimestampWithoutNetworkChecker = Instant.now();
      return true;
    }
    return false;
  }

  private boolean isNetworkAvailable() {
    if (networkCheck != null) {
      return networkCheck.isConnected();
    } else if (hadNetworkConnectionError) {
      return isNetworkReconnectionTimeout();
    } else {
      return true;
    }
  }

  protected void processResult(TranscriptionResult result, boolean resultIsFinal) {
    speechDetector.cueEvidenceOfSpeech();
    result = addSpeakerIDLabels(result);
    resultFormatter.setCurrentHypothesis(result);
    if (resultIsFinal) {
      resultFormatter.finalizeCurrentHypothesis();
    }
    sendTranscriptResultUpdated(
        resultIsFinal
            ? TranscriptionResultUpdatePublisher.UpdateType.TRANSCRIPT_FINALIZED
            : TranscriptionResultUpdatePublisher.UpdateType.TRANSCRIPT_UPDATED);
  }

  private void finalizeLeftoverHypothesis() {
    if (resultFormatter.finalizeCurrentHypothesis()) {
      sendTranscriptResultUpdated(
          TranscriptionResultUpdatePublisher.UpdateType.TRANSCRIPT_FINALIZED);
    }
  }

  private void startReconnectionTimer() {
    endSessionRequestTime = Optional.of(Instant.now());
  }

  private String getReconnectionTimerValue() {
    if (endSessionRequestTime.isPresent()) {
      Duration difference = new Duration(endSessionRequestTime.get(), Instant.now());
      return "<" + difference.getMillis() / 1000.0f + "s>";
    }
    return "<Timer not set>";
  }

  private void stopReconnectionTimer() {
    if (endSessionRequestTime.isPresent()) {
      String endTime = getReconnectionTimerValue();
//      logger.atInfo().log("Reconnection timer stopped: %s.", endTime);
    }
    endSessionRequestTime = Optional.absent();
  }

  private void sendTranscriptResultUpdated(TranscriptionResultUpdatePublisher.UpdateType type) {
    final Spanned transcript = resultFormatter.getFormattedTranscript();
    final Spanned segment = resultFormatter.getMostRecentTranscriptSegment();
    Iterator<TranscriptionResultPublisherReference> iterator = callbackRefs.iterator();

    while (iterator.hasNext()) {
      TranscriptionResultPublisherReference ref = iterator.next();
      final TranscriptionResultUpdatePublisher publisher = ref.get();
      final TranscriptionResultUpdatePublisher.ResultSource source = ref.source;
      final TranscriptionResultUpdatePublisher.UpdateType typeToSend = type;
      if (publisher == null) {
        iterator.remove();
      } else {
        resultsDeliveryService.execute(
            () -> {
              synchronized (publisher) {
                switch (source) {
                  case MOST_RECENT_SEGMENT:
                    publisher.onTranscriptionUpdate(segment, typeToSend);
                    break;
                  case WHOLE_RESULT:
                    publisher.onTranscriptionUpdate(transcript, typeToSend);
                    break;
                }
              }
            });
      }
    }
  }

  /** Returns a new proto that is labeled with speaker ID information. */
  TranscriptionResult addSpeakerIDLabels(TranscriptionResult result) {
    // We don't know whether we'll be using word level detail or not downstream, so have the
    // diarizer process everything.
    SpeakerIdInfo wholeUtteranceInfo =
        diarizer.getSpeakerIDForTimeInterval(
            TimeUtil.toInstant(result.getStartTimestamp()),
            TimeUtil.toInstant(result.getEndTimestamp()));
    List<SpeakerIdInfo> wordLevelInfo = new ArrayList<>(result.getWordLevelDetailCount());
    for (TranscriptionResult.Word word : result.getWordLevelDetailList()) {
      wordLevelInfo.add(
          diarizer.getSpeakerIDForTimeInterval(
              TimeUtil.toInstant(word.getStartTimestamp()),
              TimeUtil.toInstant(word.getEndTimestamp())));
    }
    // Protos are immutable, so to move the diarization info in, we need to make a deep copy and
    // fill in the word level data.
    return result.toBuilder()
        .setSpeakerInfo(wholeUtteranceInfo)
        .clearWordLevelDetail()
        .addAllWordLevelDetail(
            IntStream.range(0, wordLevelInfo.size())
                .mapToObj(
                    i ->
                        result.getWordLevelDetail(i).toBuilder()
                            .setSpeakerInfo(wordLevelInfo.get(i))
                            .build())
                .collect(Collectors.toList()))
        .build();
  }

  /** A Builder class for constructing RepeatingRecognitionSessions. */
  public static class Builder {
    // Required.
    private int sampleRateHz;
    private SpeechSessionFactory sessionFactory;
    private SpeechRecognitionModelOptions modelOptions;
    // Optional. Note that if you don't have either a resultFormatter or a callbackRefs there is
    // no way to get output out of the RepeatingRecognitionSession.
    private SafeTranscriptionResultFormatter resultFormatter =
        new SafeTranscriptionResultFormatter();
    private NetworkConnectionChecker networkCheck;
    private SpeechDetectionPolicy speechDetector = new AlwaysSpeechPolicy();
    private SpeakerIDLabeler diarizer =
        new AlwaysSameSpeakerIDLabeler(SpeakerIdInfo.newBuilder().setSpeakerId(0).build());
    private final ConcurrentLinkedQueue<TranscriptionResultPublisherReference> callbackRefs =
        new ConcurrentLinkedQueue<>();
    private TranscriptionErrorPublisher transcriptionErrorPublisher;
    private ExecutorService resultsDeliveryService = Executors.newCachedThreadPool();

    private Builder() {}

    public RepeatingRecognitionSession build() {
      checkArgument(sampleRateHz > 0);
      checkNotNull(modelOptions);
      checkNotNull(sessionFactory);
      return new RepeatingRecognitionSession(this);
    }

    public Builder setSampleRateHz(int sampleRateHz) {
      this.sampleRateHz = sampleRateHz;
      return this;
    }

    public Builder setSpeechSessionFactory(SpeechSessionFactory factory) {
      this.sessionFactory = factory;
      return this;
    }

    public Builder setSpeechRecognitionModelOptions(SpeechRecognitionModelOptions modelOptions) {
      this.modelOptions = modelOptions;
      return this;
    }

    public Builder setNetworkConnectionChecker(NetworkConnectionChecker networkCheck) {
      this.networkCheck = networkCheck;
      return this;
    }

    public Builder setTranscriptionResultFormatter(SafeTranscriptionResultFormatter formatter) {
      this.resultFormatter = formatter;
      return this;
    }

    public Builder setSpeechDetectionPolicy(SpeechDetectionPolicy speechDetector) {
      this.speechDetector = speechDetector;
      return this;
    }

    public Builder setSpeakerIDLabeler(SpeakerIDLabeler diarizer) {
      this.diarizer = diarizer;
      return this;
    }

    public Builder addTranscriptionResultCallback(
        TranscriptionResultUpdatePublisher callback,
        TranscriptionResultUpdatePublisher.ResultSource source) {
      checkNotNull(callback);
      Iterator<TranscriptionResultPublisherReference> iterator = callbackRefs.iterator();
      while (iterator.hasNext()) {
        if (callback.equals(iterator.next().get())) {
          throw new RuntimeException("Listener is already registered.");
        }
      }
      callbackRefs.add(new TranscriptionResultPublisherReference(callback, source));
      return this;
    }

    public Builder setTranscriptionErrorPublisher(TranscriptionErrorPublisher publisher) {
      transcriptionErrorPublisher = publisher;
      return this;
    }
  }
}
