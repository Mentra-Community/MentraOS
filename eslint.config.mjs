import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import pluginReact from "eslint-plugin-react"
import pluginReactNative from "eslint-plugin-react-native"
import pluginReactotron from "eslint-plugin-reactotron"
import pluginPrettier from "eslint-plugin-prettier"
import prettierConfig from "eslint-config-prettier"

export default [
  // Base config for all JS/TS files
  {
    files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react": pluginReact,
      "react-native": pluginReactNative,
      "reactotron": pluginReactotron,
      "prettier": pluginPrettier,
    },
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        __DEV__: "readonly", // React Native global
      },
    },
    settings: {
      react: {
        version: "detect", // Automatically detect the React version
      },
    },
  },

  // Recommended configs
  js.configs.recommended,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  pluginReact.configs.flat["jsx-runtime"],
  prettierConfig,

  // All rule overrides in one place
  {
    rules: {
      // Prettier
      "prettier/prettier": "error",

      // TypeScript
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/array-type": "off",

      // React
      "react/prop-types": "off",

      // React Native rules are scoped to RN files via an overrides block below

      // Reactotron
      "reactotron/no-tron-in-production": "error",

      // Core ESLint
      "prefer-const": "off",
      "no-use-before-define": "off",
      "comma-dangle": "off",
      "no-global-assign": "off",
      "quotes": "off",
      "space-before-function-paren": "off",
      "no-case-declarations": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["default"],
              message: "Import named exports from 'react' instead / don't import React.",
            },
            {
              name: "react-native",
              importNames: ["StyleSheet"],
              message: "Do not import StyleSheet from 'react-native'. Use ThemedStyles / the useTheme() hook instead.",
            },
            {
              name: "expo-router",
              importNames: ["useRouter"],
              message: "Do not use useRouter from expo-router. Use our useNavigationHistory hook instead.",
            },
            {
              name: "react-native",
              importNames: ["Text"],
              message: "Do not import Text from 'react-native'. Use the Ignite component with the tx prop instead.",
            },
          ],
        },
      ],
    },
  },

  // React Native-only rules (scoped override)
  // NOTE: eslint-plugin-react-native rules were being applied to web code (e.g., the console),
  // triggering RN-only checks like react-native/no-raw-text in regular React. The plugin does not
  // auto-detect platform, so we explicitly scope these rules to RN files and paths.
  {
    files: ["mobile/**/*.{js,ts,jsx,tsx}", "**/*.native.{js,ts,jsx,tsx}"],
    rules: {
      "react-native/no-unused-styles": "error",
      "react-native/split-platform-components": "warn",
      "react-native/no-inline-styles": "warn",
      "react-native/no-color-literals": "off",
      "react-native/no-raw-text": "error",
    },
  },

  // Ignore patterns
  {
    ignores: [
      // Global ignores
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.vscode/**",

      // Mobile-specific ignores
      "mobile/ios/**",
      "mobile/android/**",
      "mobile/.expo/**",
      "mobile/ignite/ignite.json",
      "mobile/package.json",

      // You might also want to add these common RN ignores
      "mobile/**/*.gradle",
      "mobile/**/*.ipa",
      "mobile/**/*.apk",
      "mobile/**/*.aab",
    ],
  },
]
