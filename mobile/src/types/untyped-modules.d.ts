declare module "bzip2" {
  const bzip2: {
    array(bytes: Uint8Array | number[]): unknown
    simple(input: unknown): string
  }

  export default bzip2
}

declare module "tar-js" {
  export interface TarEntry {
    name: string
    data: string
  }

  export default class Tar {
    append(name: string, data: string | Uint8Array | number[], options?: unknown): void
    parseTarBuffer(buffer: ArrayBuffer | Uint8Array): void
    getFiles(): TarEntry[]
    entries?: TarEntry[]
  }
}

declare module "react-native-canvas" {
  import type {Component} from "react"
  import type {ViewStyle} from "react-native"

  export interface CanvasRenderingContext2D {
    drawImage(image: Image, dx: number, dy: number, dWidth: number, dHeight: number): void
    fillRect(x: number, y: number, width: number, height: number): void
    fillStyle: string
    globalCompositeOperation: string
  }

  export default class Canvas extends Component<{style?: ViewStyle; ref?: unknown}> {
    width: number
    height: number
    getContext(contextId: "2d"): CanvasRenderingContext2D
  }

  export class Image {
    constructor(canvas: Canvas)
    width: number
    height: number
    src: string
    addEventListener(eventName: "load", listener: () => void): void
  }
}

declare module "react-native-vector-icons/MaterialCommunityIcons" {
  import type {ComponentType} from "react"
  import type {TextProps} from "react-native"

  const MaterialCommunityIcons: ComponentType<TextProps & {name: string; size?: number; color?: string}>

  export default MaterialCommunityIcons
}

declare module "react-native-vector-icons/MaterialIcons" {
  import type {ComponentType} from "react"
  import type {TextProps} from "react-native"

  const MaterialIcons: ComponentType<TextProps & {name: string; size?: number; color?: string}>

  export default MaterialIcons
}

declare module "expo-speech-transcriber" {
  export function useRealTimeTranscription(): {
    text: string
    isFinal: boolean
    error: Error | null
  }
}

declare module "react-native-sherpa-onnx/download" {
  export enum ModelCategory {
    Tts = "tts",
    Stt = "stt",
    Vad = "vad",
    Diarization = "diarization",
    Enhancement = "enhancement",
    Separation = "separation",
    Qnn = "qnn",
  }
}

declare module "react-native-sherpa-onnx" {
  export interface ModelPathConfig {
    path: string
    type?: string
  }

  export interface SherpaModelInfo {
    folder: string
    hint?: string
  }

  export function autoModelPath(path: string): ModelPathConfig
  export function assetModelPath(path: string): ModelPathConfig
  export function fileModelPath(path: string): ModelPathConfig
  export function getDefaultModelPath(): string
  export function getAssetPackPath(packName: string): Promise<string | null>
  export function listAssetModels(): Promise<SherpaModelInfo[]>
  export function listModelsAtPath(path: string): Promise<SherpaModelInfo[]>
  export function resolveModelPath(path: ModelPathConfig): Promise<string>
}

declare module "react-native-sherpa-onnx/stt" {
  import type {ModelPathConfig} from "react-native-sherpa-onnx"

  export type STTModelType = string

  export interface SttRecognitionResult {
    text: string
    tokens?: string[]
    timestamps?: unknown[]
    lang?: string
    emotion?: string
    event?: string
    durations?: unknown[]
  }

  export interface SttEngine {
    destroy(): Promise<void>
    transcribeFile(path: string): Promise<SttRecognitionResult>
  }

  export interface SttStream {
    decode(): Promise<void>
    getResult(): Promise<{text: string; tokens?: string[]; timestamps?: unknown[]}>
    inputFinished(): Promise<void>
    isReady(): Promise<boolean>
    processAudioChunk(
      samples: Float32Array | Int16Array | number[],
      sampleRate: number,
    ): Promise<{result: {text: string; tokens?: string[]; timestamps?: unknown[]}}>
    release(): Promise<void>
  }

  export interface StreamingSttEngine {
    createStream(): Promise<SttStream>
    destroy(): Promise<void>
  }

  export function createSTT(config: {modelPath: ModelPathConfig; numThreads?: number}): Promise<SttEngine>
  export function createStreamingSTT(config: {
    modelPath: ModelPathConfig
    modelType: STTModelType
    numThreads?: number
  }): Promise<StreamingSttEngine>
  export function detectSttModel(modelPath: ModelPathConfig): Promise<{
    success: boolean
    modelType?: STTModelType
    detectedModels?: Array<{type: STTModelType; modelDir: string}>
  }>
  export function getOnlineTypeOrNull(modelType?: STTModelType): STTModelType | null
}

declare module "react-native-sherpa-onnx/tts" {
  export type TTSModelType = string

  export interface TtsEngine {
    destroy(): Promise<void>
  }
}

declare module "react-native-sherpa-onnx/audio" {
  export interface PcmLiveStreamHandle {
    onData(listener: (samples: Float32Array | Int16Array | number[], sampleRate: number) => void): () => void
    onError(listener: (message: string) => void): () => void
    start(): Promise<void>
    stop(): Promise<void>
  }

  export function createPcmLiveStream(config: {sampleRate: number}): PcmLiveStreamHandle
}
