<p align="center">
  <img src="https://imagedelivery.net/nrc8B2Lk8UIoyW7fY8uHVg/97f4b31b-f239-444d-4cc4-82ee94f5be00/square" alt="Mentra AI" width="120" height="120" />
</p>

<h1 align="center">Mentra AI</h1>

<p align="center">
  <strong>Voice-first AI assistant for smart glasses</strong>
</p>

<p align="center">
  Say "Hey Mentra", ask a question, and get a concise spoken or displayed response.<br/>
  See what you see. Search the web. Remember context.
</p>

---

## What It Does

Mentra AI is an intelligent voice assistant for smart glasses. It adapts to your hardware—whether your glasses have a HUD display, camera, or speakers—and delivers responses in the most appropriate format.

- **Voice activation** — Say "Hey Mentra" to start
- **Vision** — Answers questions about what you're seeing (camera glasses)
- **Web search** — Real-time search with concise summaries
- **Context aware** — Knows your location, time, weather, and conversation history

## Supported Glasses

| Type | Input | Output |
|------|-------|--------|
| HUD + Mic | Voice | Text on display |
| Camera + Speaker + Mic | Voice + Camera | Spoken responses |

## Getting Started

### Prerequisites

1. Install MentraOS: [get.mentraglass.com](https://get.mentraglass.com)
2. Install Bun: [bun.sh](https://bun.sh/docs/installation)
3. Set up ngrok: `brew install ngrok` and create a [static URL](https://dashboard.ngrok.com/)

### Register Your App

1. Go to [console.mentra.glass](https://console.mentra.glass/)
2. Sign in and click "Create App"
3. Set a unique package name (e.g., `com.yourName.mentraAI`)
4. Enter your ngrok URL as "Public URL"
5. Add **microphone** and **camera** permissions

### Run It

```bash
# Install
git clone https://github.com/Mentra-Community/Mentra-AI.git
cd Mentra-AI
bun install
cp .env.example .env

# Configure .env with your credentials
# PORT, PACKAGE_NAME, MENTRAOS_API_KEY (required)
# GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_MAPS_API_KEY (optional)

# Start
bun run dev

# Expose via ngrok
ngrok http --url=<YOUR_NGROK_URL> 3000
```

## Documentation

- [MentraOS Docs](https://docs.mentra.glass)
- [Developer Console](https://console.mentra.glass)
- [Architecture Details](./ARCHITECTURE_PLAN.md)

## License

MIT
