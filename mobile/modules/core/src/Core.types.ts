
export type CoreMessageEventPayload = {
  message: string
}

export type CoreModuleEvents = {
  onChange: (params: ChangeEventPayload) => void
  CoreMessageEvent: (message: string) => void
}

export type ChangeEventPayload = {
  value: string
}
