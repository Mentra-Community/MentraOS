import js from "@eslint/js"
import tseslint from "typescript-eslint"
import pluginImport from "eslint-plugin-import"
import prettierConfig from "eslint-config-prettier"

export default [
  // Base recommended configs
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,

  // Main config for TypeScript files
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.d.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "import": pluginImport,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
      },
      globals: {
        // Node.js globals
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        module: "readonly",
        require: "readonly",
        exports: "readonly",
        global: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        NodeJS: "readonly",
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      // TypeScript rules
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "off",

      // Disabled: import/order causes mass file changes across PRs
      // "import/order": "off",

      // Note: import/no-restricted-paths removed - was causing issues with flat config
      // The rule from old .eslintrc.js needs different format for flat config

      // Core ESLint rules
      "no-console": "off",
      "prefer-const": "warn",
      "no-case-declarations": "warn",
    },
  },

  // Global ignores
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.vscode/**",
      "**/*.d.ts",
      "porter/**",
      "rtmp_relay/**",
      "docker/**",
    ],
  },
]
