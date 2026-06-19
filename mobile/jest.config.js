/** @type {import('@jest/types').Config.ProjectConfig} */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@babel/runtime/(.*)$": "<rootDir>/node_modules/@babel/runtime/$1",
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@assets/(.*)$": "<rootDir>/assets/$1",
    "^@mentra/bluetooth-sdk-internal$": "<rootDir>/modules/bluetooth-sdk/src/_internal.ts",
    "^expo/virtual/env$": "<rootDir>/src/test-utils/expoVirtualEnvMock.ts",
    "^react-native$": "<rootDir>/node_modules/react-native",
    "^crust$": "<rootDir>/modules/crust/src",
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
