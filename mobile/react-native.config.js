const {resolveAndroidPackageName} = require("./scripts/android-package-name.cjs")

module.exports = {
  project: {
    android: {
      packageName: resolveAndroidPackageName(),
    },
    ios: {},
  },
}
