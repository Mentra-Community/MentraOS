import {EventEmitter} from "events"

/**
 * @deprecated Use CoreModule subscriptions directly instead.
 */
const GlobalEventEmitter = new EventEmitter()

export default GlobalEventEmitter
