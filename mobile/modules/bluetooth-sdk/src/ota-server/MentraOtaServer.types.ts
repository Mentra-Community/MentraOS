export type OtaServerStatusEvent = {
  message: string
}

export type OtaServerResult = {
  baseUrl: string
  host: string
  manifestUrl: string
  port: number
}

export type MentraOtaServerModuleEvents = {
  serverStatus: (event: OtaServerStatusEvent) => void
  artifactDownloadProgress: (event: {
    destination: string
    bytesWritten: number
    contentLength: number
  }) => void
}
