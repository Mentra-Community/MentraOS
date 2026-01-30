import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import pluginReact from "eslint-plugin-react"
import pluginReactNative from "eslint-plugin-react-native"
import pluginReactotron from "eslint-plugin-reactotron"
import prettierConfig from "eslint-config-prettier"
import expoConfig from "eslint-config-expo/flat.js"
import { defineConfig } from "eslint/config"

export default defineConfig([
  // Base configs
  expoConfig,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  pluginReact.configs.flat.recommended,
  pluginReact.configs.flat["jsx-runtime"],
  prettierConfig,

  // Shared rules (all packages)
  {
    files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"],
    ignores: ["eslint.config.mjs", "metro.config.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
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

      // Core ESLint
      "prefer-const": "off",
      "no-use-before-define": "off",
      "comma-dangle": "off",
      "no-global-assign": "off",
      "quotes": "off",
      "space-before-function-paren": "off",
      "no-case-declarations": "warn",
    },
  },

  // Mobile-specific
  {
    files: ["mobile/**/*.{js,ts,jsx,tsx}"],
    plugins: {
      "react-native": pluginReactNative,
      "reactotron": pluginReactotron,
    },
    languageOptions: {
      globals: {
        __DEV__: "readonly",
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./mobile/tsconfig.json",
        },
      },
    },
    rules: {
      // React Native
      "react-native/no-unused-styles": "error",
      "react-native/split-platform-components": "warn",
      "react-native/no-inline-styles": "warn",
      "react-native/no-color-literals": "off",
      "react-native/no-raw-text": "error",

      // Reactotron
      "reactotron/no-tron-in-production": "error",

      // Mobile-specific import restrictions
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: ["default"],
              message: "Import named exports from 'react' instead.",
            },
            {
              name: "react-native",
              importNames: ["StyleSheet"],
              message: "Use ThemedStyles / useTheme() hook instead.",
            },
            {
              name: "expo-router",
              importNames: ["useRouter"],
              message: "Use useNavigationHistory hook instead.",
            },
            {
              name: "react-native",
              importNames: ["Text"],
              message: "Use the Ignite Text component with tx prop instead.",
            },
          ],
          patterns: [
            {
              group: ["../*"],
              message: "Use @/ path aliases instead of relative imports",
            },
          ],
        },
      ],
    },
  },

  // Cloud-specific
  {
    files: ["cloud/**/*.{js,ts,jsx,tsx}"],
    settings: {
      "import/resolver": {
        typescript: {
          project: "./cloud/tsconfig.json",
        },
      },
    },
    rules: {
      // Add cloud-specific rules here
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../*"],
              message: "Use @/ path aliases instead of relative imports",
            },
          ],
        },
      ],
    },
  },

  // Test files
  {
    files: [
      "**/jest.setup.js",
      "**/jest.config.js",
      "**/*.test.{js,ts,jsx,tsx}",
      "**/*.spec.{js,ts,jsx,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
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
])