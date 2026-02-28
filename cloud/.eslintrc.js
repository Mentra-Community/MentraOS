module.exports = {
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "tsconfig.json",
    sourceType: "module",
    tsconfigRootDir: __dirname,
  },
  plugins: [
    "@typescript-eslint/eslint-plugin",
    "import" 
  ],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier",
  ],
  root: true,
  env: {
    node: true,
  },
  rules: {
    "import/no-restricted-paths": [
      "error",
      {
        "zones": [
          {
            "from": ["./websites/*"], 
            //Only allow packages inside 'websites' to import each other
            "except": ["./websites"],
            "message": "Packages inside 'websites/' are private and cannot be imported by packages/apps outside of the 'websites/' directory."
          }
        ]
      }
    ]
  }
};