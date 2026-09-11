/** MentraOS-only migration bridge. This package is private and never published. */
export * from "../../engine/src/internal"
export type {
  DownloadProgress as SttDownloadProgress,
  ExtractionProgress as SttExtractionProgress,
  LanguageConfig as SttLanguageConfig,
  LanguageInfo as SttLanguageInfo,
} from "../../engine/src/services/STTModelManager"
export type {
  DownloadStage as OfflineModelDownloadStage,
  DownloadStatus as OfflineModelDownloadStatus,
} from "../../engine/src/services/OfflineSpeechModelService"
