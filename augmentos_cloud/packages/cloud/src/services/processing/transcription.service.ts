import * as azureSpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import {
  SessionEventArgs,
  SpeechRecognitionCanceledEventArgs,
  ProfanityOption,
  OutputFormat,
  AudioInputStream,
  AudioConfig,
  ConversationTranscriber,
  ConversationTranscriptionEventArgs
} from 'microsoft-cognitiveservices-speech-sdk';
import {
  StreamType,
  TranscriptionData,
  TranslationData,
  UserSession,
  ExtendedStreamType,
  getLanguageInfo,
  TranscriptSegment
} from '@augmentos/sdk';
import webSocketService from '../core/websocket.service';
import subscriptionService from '../core/subscription.service';
import { logger as rootLogger } from '../logging/pino-logger';

// Define module name constant for consistent logging
const MODULE_NAME = 'transcription.service';
// Create a module-level logger for system-wide events
const logger = rootLogger.child({ module: MODULE_NAME });

export const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "";
export const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || "";

/**
 * Extend the UserSession type with our new property.
 */
export type ExtendedUserSession = UserSession & {
  transcriptionStreams?: Map<string, ASRStreamInstance>;
};

/**
 * Interface for an individual ASR stream instance.
 */
export interface ASRStreamInstance {
  recognizer: ConversationTranscriber | azureSpeechSDK.TranslationRecognizer;
  pushStream: AudioInputStream;
}

export class TranscriptionService {
  private speechConfig: azureSpeechSDK.SpeechConfig;
  private sessionStartTime = 0;

  constructor(config: {
    speechRecognitionLanguage?: string;
    enableProfanityFilter?: boolean;
  } = {}) {
    logger.info('Initializing TranscriptionService');

    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      logger.error('Missing Azure credentials');
      throw new Error('Azure Speech key and region are required');
    }

    this.speechConfig = azureSpeechSDK.SpeechConfig.fromSubscription(
      AZURE_SPEECH_KEY,
      AZURE_SPEECH_REGION
    );

    this.speechConfig.speechRecognitionLanguage = config.speechRecognitionLanguage || 'en-US';
    // Remove profanity filtering by setting to Raw (i.e. unfiltered text)
    this.speechConfig.setProfanity(ProfanityOption.Raw);
    this.speechConfig.outputFormat = OutputFormat.Simple;

    logger.info({
      language: this.speechConfig.speechRecognitionLanguage,
      region: AZURE_SPEECH_REGION,
      format: 'Simple'
    }, 'TranscriptionService initialized');
  }

  updateTranscriptionStreams(userSession: ExtendedUserSession, desiredSubscriptions: ExtendedStreamType[]): void {
    const sessionLogger = userSession.logger.child({ module: MODULE_NAME });
    
    if (!userSession.transcriptionStreams) {
      userSession.transcriptionStreams = new Map<string, ASRStreamInstance>();
    }
    const desiredSet = new Set(desiredSubscriptions);

    // Create new streams if needed
    desiredSet.forEach(subscription => {
      if (!userSession.transcriptionStreams!.has(subscription)) {
        sessionLogger.info({ subscription }, 'Starting new transcription stream');
        const newStream = this.createASRStreamForSubscription(subscription, userSession);
        userSession.transcriptionStreams!.set(subscription, newStream);
      }
    });

    // Stop streams no longer desired
    userSession.transcriptionStreams!.forEach((streamInstance, key) => {
      if (!desiredSet.has(key)) {
        sessionLogger.info({ subscription: key }, 'Stopping transcription stream');
        this.stopIndividualTranscriptionStream(streamInstance, key, userSession);
        userSession.transcriptionStreams!.delete(key);
      }
    });
  }

  private createASRStreamForSubscription(subscription: ExtendedStreamType, userSession: ExtendedUserSession): ASRStreamInstance {
    const sessionLogger = userSession.logger.child({ module: MODULE_NAME });
    
    // Use the updated parse logic – which returns transcribeLanguage and translateLanguage.
    const languageInfo = getLanguageInfo(subscription);
    if (!languageInfo) {
      sessionLogger.error({ subscription }, 'Invalid language subscription');
      throw new Error(`Invalid language subscription: ${subscription}`);
    }

    const pushStream = azureSpeechSDK.AudioInputStream.createPushStream();
    const audioConfig = AudioConfig.fromStreamInput(pushStream);

    let recognizer: ConversationTranscriber | azureSpeechSDK.TranslationRecognizer;
    if (languageInfo.type === StreamType.TRANSLATION && languageInfo.translateLanguage) {
      // Here, use transcribeLanguage and translateLanguage.
      const translationConfig = azureSpeechSDK.SpeechTranslationConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      translationConfig.speechRecognitionLanguage = languageInfo.transcribeLanguage;
      translationConfig.addTargetLanguage(languageInfo.translateLanguage);
      // Remove profanity filtering for translation by setting to Raw
      translationConfig.setProfanity(ProfanityOption.Raw);
      recognizer = new azureSpeechSDK.TranslationRecognizer(translationConfig, audioConfig);
      
      sessionLogger.debug({ 
        subscription, 
        from: languageInfo.transcribeLanguage,
        to: languageInfo.translateLanguage,
        operation: 'startTranslation'
      }, 'Starting translation stream');
      
      recognizer.startContinuousRecognitionAsync(
        () => { 
          sessionLogger.info({ subscription }, 'Translation stream started');
        },
        (error) => {
          sessionLogger.error({ 
            error, 
            subscription,
            from: languageInfo.transcribeLanguage,
            to: languageInfo.translateLanguage
          }, 'Failed to start translation stream');
          
          this.stopIndividualTranscriptionStream({ recognizer, pushStream }, subscription, userSession);
        }
      );
    } else {
      const speechConfig = azureSpeechSDK.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = languageInfo.transcribeLanguage;
      // Remove profanity filtering for transcription by setting to Raw
      speechConfig.setProfanity(ProfanityOption.Raw);
      recognizer = new ConversationTranscriber(speechConfig, audioConfig);
      
      sessionLogger.debug({ 
        subscription, 
        language: languageInfo.transcribeLanguage,
        operation: 'startTranscription'
      }, 'Starting transcription stream');
      
      recognizer.startTranscribingAsync(
        () => { 
          sessionLogger.info({ subscription }, 'Transcription stream started');
        },
        (error: any) => {
          sessionLogger.error({ 
            error, 
            subscription,
            language: languageInfo.transcribeLanguage
          }, 'Failed to start transcription stream');
          
          this.stopIndividualTranscriptionStream({ recognizer, pushStream }, subscription, userSession);
        }
      );
    }

    const streamInstance: ASRStreamInstance = { recognizer, pushStream };
    this.setupRecognitionHandlersForInstance(streamInstance, userSession, subscription, languageInfo);
    return streamInstance;
  }

  private stopIndividualTranscriptionStream(
    streamInstance: ASRStreamInstance, 
    subscription: string, 
    userSession?: ExtendedUserSession
  ): void {
    // Use session logger if available, otherwise fall back to module logger
    const loggerToUse = userSession 
      ? userSession.logger.child({ module: MODULE_NAME }) 
      : logger;
    
    if (streamInstance.recognizer) {
      try {
        if (subscription.includes(StreamType.TRANSLATION)) {
          (streamInstance.recognizer as azureSpeechSDK.TranslationRecognizer).stopContinuousRecognitionAsync(
            () => { 
              loggerToUse.info({ subscription }, 'Stopped translation stream');
            },
            (error: any) => { 
              loggerToUse.error({ error, subscription }, 'Error stopping translation stream');
            }
          );
        } else {
          (streamInstance.recognizer as ConversationTranscriber).stopTranscribingAsync(
            () => { 
              loggerToUse.info({ subscription }, 'Stopped transcription stream');
            },
            (error: any) => { 
              loggerToUse.error({ error, subscription }, 'Error stopping transcription stream');
            }
          );
        }

        try {
          streamInstance.recognizer.close();
        } catch (error) {
          loggerToUse.warn({ error, subscription }, 'Error closing recognizer');
        }
      } catch (error) {
        loggerToUse.error({ error, subscription }, 'Error in stopIndividualTranscriptionStream');
      }
    }

    if (streamInstance.pushStream) {
      try {
        streamInstance.pushStream.close();
      } catch (error) {
        loggerToUse.warn({ error }, 'Error closing push stream');
      }
    }
  }

  private setupRecognitionHandlersForInstance(
    instance: ASRStreamInstance,
    userSession: ExtendedUserSession,
    subscription: ExtendedStreamType,
    languageInfo: { type: StreamType; transcribeLanguage: string; translateLanguage?: string }
  ): void {
    const sessionLogger = userSession.logger.child({ module: MODULE_NAME });
    
    if (languageInfo.type === StreamType.TRANSLATION) {
      // Translation branch: use recognizing and recognized.
      (instance.recognizer as azureSpeechSDK.TranslationRecognizer).recognizing = (_sender: any, event: any) => {
        if (!event.result.translations) return;

        // TODO: Find a better way to handle this
        const translateLanguage = languageInfo.translateLanguage == "zh-CN" ? "zh-Hans" : languageInfo.translateLanguage?.split('-')[0];
        const translatedText = languageInfo.transcribeLanguage === languageInfo.translateLanguage ? event.result.text : event.result.translations.get(translateLanguage);
        const didTranslate = translatedText.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').trim() !== event.result.text.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').trim();
        const detectedSourceLang = didTranslate ? languageInfo.transcribeLanguage : languageInfo.translateLanguage;

        sessionLogger.debug({ 
          subscription,
          from: detectedSourceLang,
          to: languageInfo.translateLanguage,
          text: translatedText,
          isFinal: false,
          speakerId: event.result.speakerId
        }, 'Translation interim result');
        
        const translationData: TranslationData = {
          type: StreamType.TRANSLATION,
          text: translatedText,
          originalText: event.result.text,
          startTime: this.calculateRelativeTime(event.result.offset),
          endTime: this.calculateRelativeTime(event.result.offset + event.result.duration),
          isFinal: false,
          speakerId: event.result.speakerId,
          transcribeLanguage: languageInfo.transcribeLanguage,
          translateLanguage: languageInfo.translateLanguage,
          didTranslate: didTranslate
        };
        this.broadcastTranscriptionResult(userSession, translationData);
        
        // Save transcript in the appropriate language
        this.updateTranscriptHistory(userSession, event, false, languageInfo.translateLanguage);
      };

      (instance.recognizer as azureSpeechSDK.TranslationRecognizer).recognized = (_sender: any, event: any) => {
        if (!event.result.translations) return;
        
        const translateLanguage = languageInfo.translateLanguage == "zh-CN" ? "zh-Hans" : languageInfo.translateLanguage?.split('-')[0];
        const translatedText = languageInfo.transcribeLanguage === languageInfo.translateLanguage ? event.result.text : event.result.translations.get(translateLanguage);
        // Compare normalized text to determine if translation occurred
        const didTranslate = translatedText.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').trim() !== event.result.text.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '').trim();
        const detectedSourceLang = didTranslate ? languageInfo.transcribeLanguage : languageInfo.translateLanguage;

        sessionLogger.debug({ 
          subscription,
          from: detectedSourceLang,
          to: languageInfo.translateLanguage,
          text: translatedText,
          isFinal: true,
          speakerId: event.result.speakerId,
          duration: event.result.duration
        }, 'Translation final result');
        
        const translationData: TranslationData = {
          type: StreamType.TRANSLATION,
          isFinal: true,
          text: translatedText,
          originalText: event.result.text,
          startTime: this.calculateRelativeTime(event.result.offset),
          endTime: this.calculateRelativeTime(event.result.offset + event.result.duration),
          speakerId: event.result.speakerId,
          duration: event.result.duration,
          transcribeLanguage: languageInfo.transcribeLanguage,
          translateLanguage: languageInfo.translateLanguage,
          didTranslate: didTranslate
        };
        this.broadcastTranscriptionResult(userSession, translationData);
        
        // Save transcript in the appropriate language
        this.updateTranscriptHistory(userSession, event, true, languageInfo.translateLanguage);
      };
    } else {
      // Transcription branch.
      (instance.recognizer as ConversationTranscriber).transcribing = (_sender: any, event: ConversationTranscriptionEventArgs) => {
        if (!event.result.text) return;
        
        sessionLogger.debug({ 
          subscription,
          language: languageInfo.transcribeLanguage,
          text: event.result.text,
          isFinal: false,
          speakerId: event.result.speakerId
        }, 'Transcription interim result');
        
        const transcriptionData: TranscriptionData = {
          type: StreamType.TRANSCRIPTION,
          text: event.result.text,
          startTime: this.calculateRelativeTime(event.result.offset),
          endTime: this.calculateRelativeTime(event.result.offset + event.result.duration),
          isFinal: false,
          speakerId: event.result.speakerId,
          transcribeLanguage: languageInfo.transcribeLanguage
        };

        // Save transcript for all languages, not just English
        this.updateTranscriptHistory(userSession, event, false, languageInfo.transcribeLanguage);
        this.broadcastTranscriptionResult(userSession, transcriptionData);
      };

      (instance.recognizer as ConversationTranscriber).transcribed = (_sender: any, event: ConversationTranscriptionEventArgs) => {
        if (!event.result.text) return;
        
        sessionLogger.debug({ 
          subscription,
          language: languageInfo.transcribeLanguage,
          text: event.result.text,
          isFinal: true,
          speakerId: event.result.speakerId,
          duration: event.result.duration
        }, 'Transcription final result');
        
        const transcriptionData: TranscriptionData = {
          type: StreamType.TRANSCRIPTION,
          isFinal: true,
          text: event.result.text,
          startTime: this.calculateRelativeTime(event.result.offset),
          endTime: this.calculateRelativeTime(event.result.offset + event.result.duration),
          speakerId: event.result.speakerId,
          duration: event.result.duration,
          transcribeLanguage: languageInfo.transcribeLanguage
        };

        // Save transcript for all languages, not just English
        this.updateTranscriptHistory(userSession, event, true, languageInfo.transcribeLanguage);
        this.broadcastTranscriptionResult(userSession, transcriptionData);
      };
    }

    // Common event handlers.
    instance.recognizer.canceled = (_sender: any, event: SpeechRecognitionCanceledEventArgs) => {
      sessionLogger.error({ 
        subscription,
        reason: event.reason,
        errorCode: event.errorCode,
        errorDetails: event.errorDetails
      }, 'Recognition canceled');
      
      this.stopIndividualTranscriptionStream(instance, subscription, userSession);
    };

    instance.recognizer.sessionStarted = (_sender: any, _event: SessionEventArgs) => {
      sessionLogger.info({ subscription }, 'Recognition session started');
    };

    instance.recognizer.sessionStopped = (_sender: any, _event: SessionEventArgs) => {
      sessionLogger.info({ subscription }, 'Recognition session stopped');
    };
  }

  private calculateRelativeTime(absoluteTime: number): number {
    return absoluteTime - this.sessionStartTime;
  }

  private broadcastTranscriptionResult(userSession: ExtendedUserSession, data: TranscriptionData | TranslationData): void {
    const sessionLogger = userSession.logger.child({ module: MODULE_NAME });
    
    sessionLogger.debug({ 
      streamType: data.type,
      isFinal: data.isFinal,
      operation: 'broadcast'
    }, 'Broadcasting transcription/translation result');
    
    try {
      const streamType = data.type === StreamType.TRANSLATION ? StreamType.TRANSLATION : StreamType.TRANSCRIPTION;
      webSocketService.broadcastToTpa(userSession.sessionId, streamType, data);
    } catch (error) {
      sessionLogger.error({ 
        error, 
        streamType: data.type,
        operation: 'broadcast'
      }, 'Error broadcasting result');
    }
  }

  feedAudioToTranscriptionStreams(userSession: ExtendedUserSession, audioData: Uint8Array) {
    const sessionLogger = userSession.logger.child({ module: MODULE_NAME });
    
    if (!userSession.transcriptionStreams) {
      sessionLogger.error({ 
        sessionId: userSession.sessionId,
        operation: 'feedAudio'
      }, 'No transcription streams found for session');
      return;
    }
    
    // Too verbose to log every audio feed, so we can comment this out.
    // sessionLogger.debug({ 
    //   numStreams: userSession.transcriptionStreams.size,
    //   dataSize: audioData.length,
    //   operation: 'feedAudio'
    // }, 'Feeding audio data to transcription streams');
    
    userSession.transcriptionStreams.forEach((instance, key) => {
      try {
        (instance.pushStream as any).write(audioData);
      } catch (error) {
        sessionLogger.error({ 
          error,
          streamKey: key,
          operation: 'feedAudio'
        }, 'Error writing to push stream');
      }
    });
  }

  /***********************
   * Legacy Methods
   ***********************/
  startTranscription(userSession: UserSession): void {
    const extSession = userSession as ExtendedUserSession;
    const sessionLogger = extSession.logger.child({ module: MODULE_NAME });
    
    sessionLogger.info({ 
      sessionId: extSession.sessionId,
      operation: 'startTranscription'
    }, 'Starting transcription (legacy method)');
    
    const minimalSubs = subscriptionService.getMinimalLanguageSubscriptions(extSession.sessionId);
    
    sessionLogger.debug({ 
      subscriptions: minimalSubs,
      operation: 'startTranscription'
    }, 'Retrieved minimal language subscriptions');
    
    this.updateTranscriptionStreams(extSession, minimalSubs);
  }

  stopTranscription(userSession: UserSession): void {
    const extSession = userSession as ExtendedUserSession;
    const sessionLogger = extSession.logger.child({ module: MODULE_NAME });
    
    sessionLogger.info({ 
      sessionId: extSession.sessionId,
      operation: 'stopTranscription'
    }, 'Stopping all transcription streams (legacy method)');
    
    this.updateTranscriptionStreams(extSession, []);
  }

  handlePushStreamError(userSession: UserSession, error: any): void {
    const extSession = userSession as ExtendedUserSession;
    const sessionLogger = extSession.logger.child({ module: MODULE_NAME });
    
    sessionLogger.error({ 
      error, 
      sessionId: extSession.sessionId,
      operation: 'handlePushStreamError'
    }, 'Handling push stream error, stopping transcription');
    
    this.stopTranscription(userSession);
  }

  private updateTranscriptHistory(
    userSession: ExtendedUserSession, 
    event: ConversationTranscriptionEventArgs, 
    isFinal: boolean,
    language: string = 'en-US'
  ): void {
    const sessionLogger = userSession.logger.child({ module: MODULE_NAME });
    
    // Initialize languageSegments if it doesn't exist
    if (!userSession.transcript.languageSegments) {
      sessionLogger.debug({ language }, 'Initializing language segments map');
      userSession.transcript.languageSegments = new Map<string, TranscriptSegment[]>();
    }
    
    // Ensure the language entry exists in the map
    if (!userSession.transcript.languageSegments.has(language)) {
      sessionLogger.debug({ language }, 'Creating new language segment array');
      userSession.transcript.languageSegments.set(language, []);
    }
    
    // Handle both the language-specific segments and (for backward compatibility) the legacy segments
    const segments = language === 'en-US' ? userSession.transcript.segments : [];
    const languageSegments = userSession.transcript.languageSegments.get(language)!;
    
    // Check if we need to update an interim segment
    const hasInterimLastLegacy = segments.length > 0 && !segments[segments.length - 1].isFinal;
    const hasInterimLastLanguage = languageSegments.length > 0 && !languageSegments[languageSegments.length - 1].isFinal;
    
    const currentTime = new Date();
    const newSegment = {
      resultId: event.result.resultId,
      speakerId: event.result.speakerId,
      text: event.result.text,
      timestamp: currentTime,
      isFinal: isFinal
    };

    // Handle final segment
    if (isFinal) {
      // For language-specific segments
      if (hasInterimLastLanguage) {
        languageSegments.pop(); // Remove the interim segment
      }
      languageSegments.push({...newSegment});
      
      // For backward compatibility with legacy segments (English only)
      if (language === 'en-US') {
        if (hasInterimLastLegacy) {
          segments.pop(); // Remove the interim segment
        }
        segments.push({...newSegment});
      }
    } 
    // Handle interim segment
    else {
      // For language-specific segments
      if (hasInterimLastLanguage) {
        languageSegments[languageSegments.length - 1] = {...newSegment};
      } else {
        languageSegments.push({...newSegment});
      }
      
      // For backward compatibility with legacy segments (English only)
      if (language === 'en-US') {
        if (hasInterimLastLegacy) {
          segments[segments.length - 1] = {...newSegment};
        } else {
          segments.push({...newSegment});
        }
      }
    }
    
    // Prune old segments (older than 30 minutes)
    const thirtyMinutesAgo = new Date(currentTime.getTime() - 30 * 60 * 1000);
    
    // Update language-specific segments
    const filteredLanguageSegments = languageSegments.filter(
      seg => seg.timestamp && new Date(seg.timestamp) >= thirtyMinutesAgo
    );
    userSession.transcript.languageSegments.set(language, filteredLanguageSegments);
    
    // Update legacy segments (English only) for backward compatibility
    if (language === 'en-US') {
      const filteredSegments = segments.filter(
        seg => seg.timestamp && new Date(seg.timestamp) >= thirtyMinutesAgo
      );
      userSession.transcript.segments = filteredSegments;
    }
    
    sessionLogger.debug({ 
      language, 
      segmentCount: languageSegments.length,
      isFinal: isFinal,
      operation: 'updateTranscript',
      textLength: event.result.text.length,
      resultId: event.result.resultId,
      speakerId: event.result.speakerId
    }, 'Updated transcript history');
  }
}

export const transcriptionService = new TranscriptionService();
export default transcriptionService;
