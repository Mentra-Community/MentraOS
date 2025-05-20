# Dash - Unified Content TPA

A consolidated TPA that provides different types of content to the AugmentOS dashboard based on user settings. This replaces the separate content TPAs (fun-facts-tpa, quotes-tpa, gratitude-tpa, etc.) with a single configurable application.

## Features

- Multiple content types in a single TPA
- User-configurable content selection via settings
- Adjustable content update frequency
- Consistent content format optimized for each dashboard mode
- History tracking to prevent content repetition

## Content Types

Dash supports the following content types:

- **Fun Facts**: Interesting facts on various topics
- **Inspirational Quotes**: Quotes from famous individuals
- **Gratitude Reminders**: Prompts for gratitude and mindfulness
- **News**: Brief news summaries
- **Trash Talk**: Humorous jibes and quips
- **Chinese Words**: Chinese language words with translations

## Setup

### Prerequisites

- Node.js 18+ or Bun runtime
- AugmentOS API key

### Environment Variables

Create a `.env` file in the root directory with the following variables:

```
PORT=3100
CLOUD_LOCAL_HOST_NAME=cloud
AUGMENTOS_AUTH_JWT_SECRET=your_augmentos_api_key
```

### Installation

```bash
# Using npm
npm install

# Using Bun
bun install
```

### Running the App

```bash
# Using npm
npm run dev

# Using Bun
bun run dev
```

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /admin/sessions` - List active sessions with their settings
- `POST /admin/generate-content` - Force generate new content for a session

## Docker Support

Build and run with Docker:

```bash
docker build -t dash .
docker run -p 3100:3100 -e AUGMENTOS_AUTH_JWT_SECRET=your_key dash
```

## Usage

1. Install and run the Dash TPA
2. Configure content settings in the AugmentOS settings panel
3. Content will appear in the dashboard based on your selected preferences
4. Look up to get new content at any time