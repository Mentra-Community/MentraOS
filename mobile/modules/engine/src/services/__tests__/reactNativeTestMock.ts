/// <reference types="bun-types" />

import {mock} from "bun:test"

/**
 * One `react-native` stub for the whole bun process.
 *
 * bun links named exports when the first `mock.module` runs. A later factory
 * cannot add names — `AudioPlaybackService` importing `AppState` then throws
 * if an earlier file mocked only `Platform`. Register every name the suites
 * need, once, and let each file overwrite the values.
 */
export const reactNativeAppState = {
  currentState: "active" as string,
  addEventListener: () => ({remove: () => {}}),
}

export const reactNative: Record<string, unknown> = {
  AppState: reactNativeAppState,
  Platform: {OS: "android", Version: 30},
  Alert: {alert: mock(() => {})},
  Linking: {openSettings: mock(async () => {})},
  PermissionsAndroid: {
    PERMISSIONS: {},
    RESULTS: {DENIED: "denied", GRANTED: "granted"},
    check: mock(async () => false),
    request: mock(async () => "denied"),
    requestMultiple: mock(async () => ({})),
  },
}

mock.module("react-native", () => reactNative)
