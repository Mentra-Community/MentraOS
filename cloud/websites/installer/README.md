# MentraOS PWA Installer

A Progressive Web App (PWA) installer website that provides platform-specific instructions for installing MentraOS as a native-like app on iOS, Android, and desktop devices.

## Features

- **Platform Detection**: Automatically detects the user's device (iOS, Android, Desktop) and shows relevant installation instructions
- **URL Redirect Parameter**: Accepts a `?url=` parameter to specify where the app should redirect after installation
- **PWA Ready**: Includes manifest.json and service worker support
- **Responsive Design**: Works seamlessly across all device sizes
- **Tailwind CSS**: Modern styling matching other MentraOS websites

## Usage

### Basic Usage

Navigate users to the installer page:

```
https://your-domain.com/
```

### With Redirect URL

To redirect users to a specific URL after installation:

```
https://your-domain.com/?url=https://apps.mentra.glass
```

The redirect URL is stored in `localStorage` and can be accessed after the PWA is installed.

## Development

### Install Dependencies

```bash
bun install
```

### Start Dev Server

```bash
bun run dev
```

### Build for Production

```bash
bun run build
```

### Preview Production Build

```bash
bun run preview
```

## How It Works

1. User visits the installer page with optional `?url=` parameter
2. The app detects the user's platform (iOS, Android, or Desktop)
3. Platform-specific installation instructions are displayed
4. The redirect URL (if provided) is stored in `localStorage`
5. After PWA installation, your custom detection logic can read the URL from `localStorage` with the key `pwa_redirect_url` and redirect accordingly

## Project Structure

```
installer/
├── public/
│   ├── manifest.json          # PWA manifest
│   ├── icon.svg              # Favicon
│   └── icon-placeholder.txt  # Instructions for PWA icons
├── src/
│   ├── components/
│   │   └── ui/               # Reusable UI components
│   ├── lib/
│   │   └── utils.ts          # Utility functions
│   ├── pages/
│   │   └── InstallGuide.tsx  # Main installation guide page
│   ├── App.tsx               # Main app component
│   ├── main.tsx              # Entry point
│   └── index.css             # Global styles
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## PWA Icons

The app requires the following icon files in the `public/` directory:

- `icon-192.png` (192x192 pixels)
- `icon-512.png` (512x512 pixels)
- `icon-192-maskable.png` (192x192 pixels with safe zone)
- `icon-512-maskable.png` (512x512 pixels with safe zone)

See `public/icon-placeholder.txt` for more details.

## Adding PWA Detection Logic

After the user installs the PWA and opens it, you can check if they should be redirected:

```typescript
// In your app initialization code
const redirectUrl = localStorage.getItem('pwa_redirect_url');
const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

if (redirectUrl && isStandalone) {
  // User has installed the PWA and there's a redirect URL
  window.location.href = redirectUrl;
  // Optionally clear the redirect URL after use
  localStorage.removeItem('pwa_redirect_url');
}
```

## Tech Stack

- React 18.2.0
- TypeScript
- Vite
- Tailwind CSS v4
- React Router DOM
- Radix UI components
- Lucide React icons

## License

Part of the MentraOS project.
