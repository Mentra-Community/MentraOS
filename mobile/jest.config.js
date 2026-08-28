/** @type {import('@jest/types').Config.ProjectConfig} */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@babel/runtime/(.*)$": "<rootDir>/node_modules/@babel/runtime/$1",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@assets/(.*)$": "<rootDir>/assets/$1",
    "^@mentra/bluetooth-sdk-internal$": "<rootDir>/modules/bluetooth-sdk/src/_internal.ts",
    "^@mentra/bluetooth-sdk/internal$": "<rootDir>/modules/bluetooth-sdk/src/_internal.ts",
    // Mirror metro: the @mentra/engine entry points resolve to SOURCE, not the
    // (stale) build/ output — tests must exercise the same code the app
    // bundles. jest.setup.js mocks the runtime entries; /ota stays real.
    "^@mentra/engine$": "<rootDir>/modules/engine/src/index.ts",
    "^@mentra/engine-host-internal$": "<rootDir>/modules/engine-host-internal/src/index.ts",
    "^@mentra/engine-host-internal/devtools$": "<rootDir>/modules/engine-host-internal/src/devtools.ts",
    "^@mentra/engine/ota$": "<rootDir>/modules/engine/src/react/index.ts",
    "^expo/virtual/env$": "<rootDir>/src/test-utils/expoVirtualEnvMock.ts",
    "^react-native$": "<rootDir>/node_modules/react-native",
    "^crust$": "<rootDir>/modules/crust/src",
    // island-internal code (e.g. RestComms) reaches the full btsdk surface via the
    // relative build/_internal path (the @mentra/bluetooth-sdk-internal alias
    // doesn't resolve in island's standalone build). Map it to the same source so
    // the jest.setup mock applies — otherwise requireActual loads the real native module.
    "bluetooth-sdk/build/_internal$": "<rootDir>/modules/bluetooth-sdk/src/_internal.ts",
  },
  testPathIgnorePatterns: [
    "<rootDir>/modules/engine/",
    "<rootDir>/modules/jspolyfill/",
    "<rootDir>/modules/miniapp/",
    "<rootDir>/src/services/photo/",
    "<rootDir>/src/services/streaming/",
    // bun:test suites — run via `bun test`, not Jest (cannot resolve "bun:test").
    "<rootDir>/src/stores/settings.test.ts",
    "<rootDir>/src/services/qrScanRequest.test.ts",
    "<rootDir>/src/__tests__/app/miniapps/settings/camera.test.tsx",
  ],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|@jsamr/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-marked|react-native-reanimated-table|marked|github-slugger|html-entities|svg-parser|core|typesafe-ts|uniwind)",
  ],
}
