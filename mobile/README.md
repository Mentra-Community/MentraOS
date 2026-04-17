### Quickstart

## Requirements

**⚠️ Physical Device Required**

MentraOS relies heavily on BLE/Bluetooth connectivity to communicate with smart glasses. **Android Emulator and iOS Simulator do not support Bluetooth**, so you **must use a physical device** for testing MentraOS.

### Windows Setup

```bash
// Clone directly to the C:\ directory to avoid path length limits on windows!
git clone https://github.com/Mentra-Community/MentraOS
git checkout dev
```

```
choco install -y nodejs-lts microsoft-openjdk17
```

Install swiftformat from https://github.com/nicklockwood/SwiftFormat/releases

### Mac Setup

1. **Install tooling** (Homebrew):

   ```bash
   brew install bun node@20 android-platform-tools
   ```

   Install **Android Studio** and open it once so the Android SDK, NDK, and build tools install. Default SDK path is `~/Library/Android/sdk`.

2. **Shell environment** — add to `~/.zshrc` (adjust paths if your SDK or Studio install differs):

   ```bash
   export BUN_INSTALL="$HOME/.bun"
   export PATH="$BUN_INSTALL/bin:$PATH"
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export ANDROID_SDK_ROOT="$ANDROID_HOME"
   export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
   ```

   Then `source ~/.zshrc`.

3. **Global Gradle** — optional but recommended so Expo-regenerated `android/` still finds Java and Node. Create or edit `~/.gradle/gradle.properties`:
   - Point `org.gradle.java.home` at Android Studio’s JBR (same path as `JAVA_HOME` above).
   - Set `org.gradle.jvmargs` to include `-Dorg.gradle.project.nodePath=/opt/homebrew/bin/node` (or your `which node`).
   - Optionally set `sdk.dir` to your Android SDK path.

   The `bun android` script runs `expo prebuild` and then pins the Gradle wrapper and writes `android/local.properties` so builds keep working after regenerating `android/`.

4. **Git** — set `git config --global user.name` (and `user.email`) so local build metadata scripts don’t fail on missing identity.

5. **Run Android** — use a **physical device** (BLE is not available in emulators):

Create a mobile/.env with valid values.

```bash
bun install
bun android
```

(`bun android` runs prebuild, then `expo run:android` on a connected device.)

Then iterate on code with

```bash
bun start --clear
```

For iOS on Mac, follow the **iOS** section below (Xcode, CocoaPods).

## Android

```
bun install
bun expo prebuild
bun android
```

## iOS

### deps

```
brew install swiftformat
brew install bun
brew install openjdk@17
```

```
bun install
bun expo prebuild
cd ios
pod install
cd .. && open ios/AOS.xcworkspace
(install a dev build on your phone using xcode)
bun run start
```

for pure JS changes once you have a build installed all you need to run is
`bun run start`

## IF YOU HAVE ISSUES BUILDING DUE TO UI REFRESH, SEE HERE:

Due to the UI refresh there will be some weird cache issues. Do this to fix them...

```
bun install
bun expo prebuild
rm -rf android/build android/.gradle node_modules .expo .bundle android/app/build android/app/src/main/assets
bun install
./scripts/fix-react-native-symlinks.sh
bun android
bun run start
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

---

### Development Guidelines

For detailed coding standards and best practices for MentraOS Manager development, please see our [MentraOS Manager Development Guidelines](https://docs.mentraos.com/contributing/mentraos-manager-guidelines).
