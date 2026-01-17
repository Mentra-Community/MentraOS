# Mentra Discord Bot

Discord bot for managing bug reports in the Mentra community.

## Features

- **Bug Report Modal**: Structured bug report form with private email collection
- **Bug Detection**: Automatically detects potential bug reports in wrong channels and redirects users
- **Private Email Storage**: Emails are collected privately and never posted publicly
- **Low Priority Marking**: Reports without email are visually marked as limited-debug
- **Mod Tools**: `/lookup-email` command for mods to get email for a specific bug report

## Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and name it "Mentra Bot"
3. Go to "Bot" section and click "Add Bot"
4. Copy the **Bot Token** (keep this secret!)
5. Go to "General Information" and copy the **Application ID**

### 2. Configure Bot Permissions

In the Bot settings, enable these **Privileged Gateway Intents**:
- Message Content Intent
- Server Members Intent (optional, but useful)

### 3. Invite Bot to Server

1. Go to OAuth2 > URL Generator
2. Select scopes: `bot`, `applications.commands`
3. Select bot permissions:
   - Read Messages/View Channels
   - Send Messages
   - Manage Messages (for deleting misplaced bugs)
   - Use Slash Commands
   - Create Public Threads
   - Send Messages in Threads
   - Embed Links
4. Copy the generated URL and open it to invite the bot

### 4. Get Discord IDs

Enable Developer Mode in Discord (User Settings > Advanced > Developer Mode)

Right-click to copy IDs for:
- **Server ID**: Right-click your server name > Copy Server ID
- **Bug Reports Channel ID**: Right-click the #bug-reports forum channel > Copy Channel ID
- **Watched Channel IDs** (optional): Right-click channels like #general

### 5. Configure Environment

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
DISCORD_GUILD_ID=your_server_id_here
DISCORD_BUG_REPORT_CHANNEL_ID=your_bug_reports_channel_id
DISCORD_WATCHED_CHANNEL_IDS=general_channel_id,support_channel_id
```

### 6. Set Up Forum Tags (Recommended)

In your #bug-reports forum channel, add these tags:
- `Has Email` (green)
- `No Email` (orange)
- `iOS`
- `Android`
- `In Progress`
- `Resolved`
- `Need More Info`

## Running the Bot

### Local Development

```bash
cd cloud/packages/discord-bot
bun install
bun run dev
```

### With Docker (Standalone)

```bash
cd cloud/packages/discord-bot
cp .env.example .env
# Fill in your Discord credentials
docker compose up -d
```

## Usage

### For Users

1. Go to #bug-reports channel
2. Click the "New Bug Report" button
3. Fill out the modal form
4. Bug report is created as a forum thread

### For Moderators

- `/setup-bug-reports` - Post the bug report button in the forum channel
- `/lookup-email <thread-id>` - Get the private email for a bug report

## How It Works

### Bug Report Flow

1. User clicks "New Bug Report" button
2. Modal opens with fields:
   - What happened? (required)
   - What should have happened? (required)
   - Steps to reproduce (optional)
   - Platform & Device (required)
   - Email (private, optional)
3. Bot creates forum thread with public info
4. Email is stored privately, linked to thread ID
5. Thread is tagged based on email status

### Bug Detection

When a user posts in watched channels:
1. Bot analyzes message for bug-related keywords/patterns
2. If detected, bot:
   - DMs user with redirect instructions
   - Deletes the original message
3. User is guided to use the proper bug report flow

## Data Storage

Currently uses in-memory storage for email mapping. In production, this should be replaced with a database connection to persist data across restarts.

## Troubleshooting

**Bot doesn't respond to button clicks**
- Check bot has proper permissions
- Ensure bot is in the server
- Check console for errors

**Messages not being deleted**
- Bot needs "Manage Messages" permission
- Check if bot role is above other roles in hierarchy

**Slash commands not showing**
- Commands register on startup
- May take up to an hour for Discord to propagate
- Try restarting the bot

**Can't DM users**
- Some users have DMs disabled
- Bot will fall back to replying in channel
