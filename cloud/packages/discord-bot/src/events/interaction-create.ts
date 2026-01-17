import { Interaction } from 'discord.js';
import { BotConfig } from '../types/config';
import {
  BUG_REPORT_BUTTON_ID,
  BUG_REPORT_MODAL_ID,
  handleBugReportButton,
  handleBugReportModalSubmit
} from '../commands/bug-report';
import { logger } from '../services/logger';

/**
 * Handle all interactions (buttons, modals, commands)
 */
export async function handleInteraction(interaction: Interaction, config: BotConfig): Promise<void> {
  try {
    // Handle button interactions
    if (interaction.isButton()) {
      if (interaction.customId === BUG_REPORT_BUTTON_ID) {
        await handleBugReportButton(interaction);
        return;
      }
    }

    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      if (interaction.customId === BUG_REPORT_MODAL_ID) {
        await handleBugReportModalSubmit(interaction, config.bugReportChannelId);
        return;
      }
    }

    // Handle slash commands (future expansion)
    if (interaction.isChatInputCommand()) {
      logger.debug({ commandName: interaction.commandName }, 'Received slash command');
      // Add slash command handlers here if needed
    }

  } catch (error) {
    logger.error({ error, interactionId: interaction.id }, 'Error handling interaction');

    // Try to respond with an error message
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: 'An error occurred while processing your request. Please try again.',
          ephemeral: true
        });
      } catch (replyError) {
        logger.error({ error: replyError }, 'Failed to send error reply');
      }
    }
  }
}
