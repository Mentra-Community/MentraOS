/** @type {import('@babel/core').TransformOptions} */
module.exports = function (api: any) {
  api.cache(true)
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: ["./"],
          alias: {
            "@": "./src",
            // "assets": "./assets",
            "@plugins": "./plugins",
            "@assets": "./assets",
            "@cloud": "../cloud/packages/types",
          },
          extensions: [".ios.js", ".android.js", ".js", ".ts", ".tsx", ".json"],
        },
      ],
    ],
  }
}
