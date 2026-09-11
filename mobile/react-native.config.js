module.exports = {
  project: {
    android: {
      packageName:
        process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china" ? "com.mentra.mentra.cn" : "com.mentra.mentra",
    },
    ios: {},
  },
}
