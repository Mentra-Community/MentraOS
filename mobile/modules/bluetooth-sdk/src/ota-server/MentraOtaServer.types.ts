export type OtaServerResult = {
  baseUrl: string
  host: string
  manifestUrl: string
  port: number
}

export type MentraOtaServerModuleEvents = {
  artifactDownloadProgress: (event: {destination: string; bytesWritten: number; contentLength: number}) => void
}
