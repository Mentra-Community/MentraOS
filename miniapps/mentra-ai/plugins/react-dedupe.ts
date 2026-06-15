/**
 * Bun plugin to deduplicate React by resolving all React imports to the app's node_modules.
 * This fixes the "Invalid hook call" error when using linked packages like @mentra/react
 * that have their own React in their node_modules.
 */
import type { BunPlugin } from "bun";
import path from "path";

const reactDedupePlugin: BunPlugin = {
  name: "react-dedupe",
  setup(build) {
    // Get the absolute path to our local react
    const appNodeModules = path.resolve(import.meta.dir, "../node_modules");

    // Force all 'react' imports to resolve to our local copy
    build.onResolve({ filter: /^react$/ }, (args) => {
      return {
        path: path.resolve(appNodeModules, "react/index.js"),
      };
    });

    // Force jsx-runtime imports to resolve to our local copy
    build.onResolve({ filter: /^react\/jsx-runtime$/ }, (args) => {
      return {
        path: path.resolve(appNodeModules, "react/jsx-runtime.js"),
      };
    });

    build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, (args) => {
      return {
        path: path.resolve(appNodeModules, "react/jsx-dev-runtime.js"),
      };
    });
  },
};

export default reactDedupePlugin;
