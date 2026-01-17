import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  Partials
} from 'discord.js';
import * as dotenv from 'dotenv';
import { BotConfig } from './types/config';
import { handleMessageCreate } from './events/message-create';
import { handleInteraction } from './events/interaction-create';
import { setupCommand, handleSetupCommand } from './commands/setup';
import { lookupEmailCommand, handleLookupEmailCommand } from './commands/lookup-email';
import { logger } from './services/logger';

// Load environment variables
dotenv.config();

// Validate required environment variables
function loadConfig(): BotConfig {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  const bugReportChannelId = process.env.DISCORD_BUG_REPORT_CHANNEL_ID;

  if (!token) throw new Error('DISCORD_BOT_TOKEN is required');
  if (!clientId) throw new Error('DISCORD_CLIENT_ID is required');
  if (!guildId) throw new Error('DISCORD_GUILD_ID is required');
  if (!bugReportChannelId) throw new Error('DISCORD_BUG_REPORT_CHANNEL_ID is required');

  // Optional: comma-separated list of channel IDs to watch
  const watchedChannelsEnv = process.env.DISCORD_WATCHED_CHANNEL_IDS || '';
  const watchedChannelIds = watchedChannelsEnv
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);

  return {
    token,
    clientId,
    guildId,
    bugReportChannelId,
    watchedChannelIds
  };
}

async function registerCommands(config: BotConfig): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);

  const commands = [
    setupCommand.toJSON(),
    lookupEmailCommand.toJSON()
  ];

  try {
    logger.info('Registering slash commands...');

    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );

    logger.info('Slash commands registered successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to register slash commands');
    throw error;
  }
}

async function main(): Promise<void> {
  logger.info('Starting Mentra Discord Bot...');

  const config = loadConfig();

  // Create Discord client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [
      Partials.Channel, // Required for DMs
      Partials.Message
    ]
  });

  // Register slash commands
  await registerCommands(config);

  // Event: Bot ready
  client.once(Events.ClientReady, (readyClient) => {
    logger.info({ username: readyClient.user.tag }, 'Bot is ready!');
  });

  // Event: Message created (for bug detection)
  client.on(Events.MessageCreate, async (message) => {
    await handleMessageCreate(message, config);
  });

  // Event: Interaction (buttons, modals, commands)
  client.on(Events.InteractionCreate, async (interaction) => {
    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'setup-bug-reports') {
        await handleSetupCommand(interaction);
        return;
      }
      if (interaction.commandName === 'lookup-email') {
        await handleLookupEmailCommand(interaction);
        return;
      }
    }

    // Handle other interactions (buttons, modals)
    await handleInteraction(interaction, config);
  });

  // Error handling
  client.on(Events.Error, (error) => {
    logger.error({ error }, 'Discord client error');
  });

  // Login
  await client.login(config.token);
}

// Run the bot
main().catch((error) => {
  logger.error({ error }, 'Failed to start bot');
  process.exit(1);
});
