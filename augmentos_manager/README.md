# Welcome to your new ignited app!

> The latest and greatest boilerplate for Infinite Red opinions

This is the boilerplate that [Infinite Red](https://infinite.red) uses as a way to test bleeding-edge changes to our React Native stack.

- [Quick start documentation](https://github.com/infinitered/ignite/blob/master/docs/boilerplate/Boilerplate.md)
- [Full documentation](https://github.com/infinitered/ignite/blob/master/docs/README.md)

### Quickstart

build and run the app on android from scratch:

## Android
```
pnpm install
pnpm expo prebuild
pnpm android
```

## iOS
```
pnpm install
pnpm expo prebuild
cd ios
pod install
cd ..
open ios/AOS.xcworkspace
(install a dev build on your phone using xcode)
pnpm run start
```

for pure JS changes once you have a build installed all you need to run is
```pnpm run start```

## IF YOU HAVE ISSUES BUILDING DUE TO UI REFRESH, SEE HERE:
Due to the UI refresh there will be some weird cache issues. Do this to fix them...

```
pnpm install
pnpm expo prebuild
rm -rf android/build android/.gradle node_modules .expo .bundle android/app/build android/app/src/main/assets
pnpm install
./fix-react-native-symlinks.sh 
pnpm android
pnpm run start
```

## Getting Started

```bash
pnpm install
pnpm run start
```

To make things work on your local simulator, or on your phone, you need first to [run `eas build`](https://github.com/infinitered/ignite/blob/master/docs/expo/EAS.md). We have many shortcuts on `package.json` to make it easier:

```bash
pnpm run build:ios:sim # build for ios simulator
pnpm run build:ios:dev # build for ios device
pnpm run build:ios:prod # build for ios device
```

### `./assets` directory

This directory is designed to organize and store various assets, making it easy for you to manage and use them in your application. The assets are further categorized into subdirectories, including `icons` and `images`:

```tree
assets
├── icons
└── images
```

**icons**
This is where your icon assets will live. These icons can be used for buttons, navigation elements, or any other UI components. The recommended format for icons is PNG, but other formats can be used as well.

Ignite comes with a built-in `Icon` component. You can find detailed usage instructions in the [docs](https://github.com/infinitered/ignite/blob/master/docs/boilerplate/app/components/Icon.md).

**images**
This is where your images will live, such as background images, logos, or any other graphics. You can use various formats such as PNG, JPEG, or GIF for your images.

Another valuable built-in component within Ignite is the `AutoImage` component. You can find detailed usage instructions in the [docs](https://github.com/infinitered/ignite/blob/master/docs/Components-AutoImage.md).

How to use your `icon` or `image` assets:

```typescript
import { Image } from 'react-native';

const MyComponent = () => {
  return (
    <Image source={require('../assets/images/my_image.png')} />
  );
};
```

## Running Maestro end-to-end tests

Follow our [Maestro Setup](https://ignitecookbook.com/docs/recipes/MaestroSetup) recipe.

## Next Steps

### Ignite Cookbook

[Ignite Cookbook](https://ignitecookbook.com/) is an easy way for developers to browse and share code snippets (or “recipes”) that actually work.

### Upgrade Ignite boilerplate

Read our [Upgrade Guide](https://ignitecookbook.com/docs/recipes/UpdatingIgnite) to learn how to upgrade your Ignite project.


## Overview of changes

- essentially all imports have been refactored to use absolute paths instead of relative paths
- there is no longer a src/screens folder, as screens have been replaced with expo-router's file based routing (react-navigation under the hood) 
- most components have been categorized into folders or the misc/ folder
- most components now use the theme/themed from the useAppTheme() hook
