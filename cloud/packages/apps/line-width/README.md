# Line Width Debug Tool

A debug application to discover and validate optimal text wrapping logic for G1 glasses display by testing actual pixel widths against glasses firmware behavior.

## Problem

We have two sources of truth for text width that need alignment:

1. **Our pixel calculations** - Based on glyph data from `G1FontLoaderKt`
2. **Glasses firmware behavior** - What actually wraps/clips on the display

Currently, we guess at character limits (30/38/44), but different characters have different widths:

- `l` (1px glyph) vs `a` (5px glyph) vs `m` (7px glyph)
- We should be able to fit MORE narrow characters per line

## Approach

Build a debug tool that:

1. Sends raw text to glasses (mobile wrapping disabled)
2. Shows a preview of what we sent + calculated pixel width
3. Lets user report whether text displayed as single line, wrapped, or clipped
4. Tracks results to validate our pixel calculations

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed
- MentraOS account at [console.mentra.glass](https://console.mentra.glass)
- Smart glasses connected to MentraOS app

### Installation

```bash
bun install
```

### Configuration

Create `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```env
PORT=3333
PACKAGE_NAME=com.mentra.linewidth
MENTRAOS_API_KEY=your_api_key_here
NODE_ENV=development
```

### Development

```bash
bun run dev
```

The app will start:

- ✅ Bun server at `http://localhost:3334` (webview + API)
- ✅ Express server at `http://localhost:3333` (MentraOS integration)

## Usage

1. Start the debug tool: `bun run dev`
2. Open browser: `http://localhost:3333`
3. Connect glasses via MentraOS app
4. Use the UI to:
   - Generate test strings (narrow, average, wide characters)
   - Send text to glasses
   - Mark results (single-line, wrapped, clipped)
   - Track test history

## Pixel Width Formula

From `G1Text.kt`:

```
pixel_width = (glyph_width + 1) × 2
```

### Character Width Examples

| Char Type | Glyph Width | Pixels/Char | Max at 428px |
| --------- | ----------- | ----------- | ------------ |
| `l`       | 1px         | 4px         | ~107 chars   |
| `a`       | 5px         | 12px        | ~35 chars    |
| `m`       | 7px         | 16px        | ~26 chars    |

## Project Structure

```
line-width/
├── src/
│   ├── index.ts           # Main entry point
│   ├── api/               # API routes
│   │   ├── routes.ts      # Route definitions
│   │   └── auth-helpers.ts
│   ├── app/
│   │   └── index.ts       # LineWidthApp (MentraOS integration)
│   └── webview/           # React frontend
│       ├── App.tsx        # Main app component
│       ├── components/
│       │   ├── Header.tsx
│       │   └── Settings.tsx  # Debug controls
│       └── ...
├── issues/                # Issue tracking docs
│   ├── line-width-debug-tool/
│   └── line-width-optimization/
├── package.json
└── README.md
```

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/me` - Auth info
- `POST /api/send-text` - Send text to glasses
- `GET /api/glyph-widths` - Get glyph width data

## Documentation

See the `issues/` folder for detailed specs:

- `issues/line-width-debug-tool/` - Debug tool spec and architecture
- `issues/line-width-optimization/` - Optimization goals and approach

## Resources

- [MentraOS Documentation](https://docs.mentra.glass)
- [Developer Console](https://console.mentra.glass)
- [Discord Community](https://discord.gg/5ukNvkEAqT)