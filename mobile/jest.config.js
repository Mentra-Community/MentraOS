/** @type {import('@jest/types').Config.ProjectConfig} */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@babel/runtime/(.*)$": "<rootDir>/node_modules/@babel/runtime/$1",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@assets/(.*)$": "<rootDir>/assets/$1",
    "^@mentra/bluetooth-sdk-internal$": "<rootDir>/modules/bluetooth-sdk/src/_internal.ts",
    // Island entry points resolve to source (like bluetooth-sdk-internal above)
    // so resolution never depends on stale build/ output; jest.setup.js mocks
    // both subpaths alongside the main "@mentra/island" mock.
    "^@mentra/island/internal$": "<rootDir>/modules/island/src/internal.ts",
    "^@mentra/island/devtools$": "<rootDir>/modules/island/src/devtools.ts",
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
    "<rootDir>/modules/island/",
    "<rootDir>/modules/jspolyfill/",
    "<rootDir>/modules/miniapp/",
    "<rootDir>/src/services/photo/",
    "<rootDir>/src/services/streaming/",
  ],
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|core|typesafe-ts|uniwind)",
  ],
}
