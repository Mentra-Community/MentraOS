type Listener = (payload: any) => void

const listeners = new Map<string, Set<Listener>>()

const addListener = jest.fn((eventName: string, listener: Listener) => {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set())
  }
  listeners.get(eventName)!.add(listener)

  return {
    remove: () => {
      listeners.get(eventName)?.delete(listener)
    },
  }
})

export const crustModuleMock = {
  addListener,
  hello: jest.fn(() => "Hello world!"),
  setValueAsync: jest.fn(() => Promise.resolve()),
  showAVRoutePicker: jest.fn(),
  setNotificationConfig: jest.fn(() => Promise.resolve()),
  getInstalledApps: jest.fn(() => Promise.resolve([])),
  getInstalledAppsForNotifications: jest.fn(() => Promise.resolve([])),
  hasNotificationListenerPermission: jest.fn(() => Promise.resolve(false)),
  openNotificationListenerSettings: jest.fn(() => Promise.resolve(false)),
  isBetaBuild: jest.fn(() => Promise.resolve(false)),
  processGalleryImage: jest.fn(() => Promise.resolve({success: true})),
  mergeHdrBrackets: jest.fn(() => Promise.resolve({success: true})),
  stabilizeVideo: jest.fn(() => Promise.resolve({success: true})),
  saveToGalleryWithDate: jest.fn(() => Promise.resolve({success: true})),
}

export const emitCrustEvent = (eventName: string, payload: any) => {
  listeners.get(eventName)?.forEach((listener) => listener(payload))
}

export const resetCrustModuleMock = () => {
  listeners.clear()
  Object.values(crustModuleMock).forEach((value) => {
    if (typeof value === "function" && "mockClear" in value) {
      value.mockClear()
    }
  })
}
