### Quickstart

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

## Android

### Development Build (Requires Metro Server)

For development builds that connect to Metro bundler:

```bash
bun install
bun expo prebuild
bun android
```

### Release Build (Standalone APK)

For production builds that bundle JavaScript and work without Metro server:

```bash
bun run build:android:release
```

This command will:

- Fix React Native symlinks
- Run Expo prebuild
- Build a release APK with JavaScript bundled
- Install the APK on your connected device

The release APK will be located at:

```
mobile/android/app/build/outputs/apk/release/app-release.apk
```

**Note**: The release APK works independently without USB connection or Metro server, as JavaScript is bundled into the APK.

### Environment Variables

Before building, ensure you have the required environment variables set:

**`android_core/.env`** (required for core service):

```env
MENTRAOS_HOST=stagingapi.mentraglass.com
MENTRAOS_PORT=443
MENTRAOS_SECURE=true
```

**`mobile/.env`** (required for mobile app):

```env
MENTRAOS_VERSION=2.2.15
MENTRAOS_APPSTORE_URL=https://appsbeta.mentraglass.com
POSTHOG_API_KEY=your_posthog_key
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
SENTRY_DSN=your_sentry_dsn
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
./fix-react-native-symlinks.sh
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
