// Polyfill Event for livekit-client (Hermes doesn't have browser Event class)
// This file must be imported before any livekit imports
if (typeof global.Event === "undefined") {
  // @ts-ignore
  global.Event = class Event {
    type: string
    bubbles: boolean
    cancelable: boolean
    currentTarget: any
    constructor(type: string, options: {bubbles?: boolean; cancelable?: boolean} = {}) {
      this.type = type
      this.bubbles = options.bubbles || false
      this.cancelable = options.cancelable || false
      this.currentTarget = null
    }
  }
}
