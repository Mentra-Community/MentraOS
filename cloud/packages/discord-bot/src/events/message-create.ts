import { Events, Message } from 'discord.js';
import { BotConfig } from '../types/config';
import { isBugReport, createBugRedirectMessage, createDeletionReason } from '../services/bug-detector';
import { logger } from '../services/logger';

/**
 * Handle incoming messages and check for misplaced bug reports
 */
export async function handleMessageCreate(message: Message, config: BotConfig): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  // Ignore messages in the bug report channel (that's where they should be!)
  if (message.channelId === config.bugReportChannelId) return;

  // Only watch configured channels (if specified)
  // If no watched channels specified, watch all channels except bug-reports
  if (config.watchedChannelIds.length > 0) {
    if (!config.watchedChannelIds.includes(message.channelId)) {
      return;
    }
  }

  // Check if this looks like a bug report
  if (!isBugReport(message)) {
    return;
  }

  logger.info({
    userId: message.author.id,
    username: message.author.username,
    channelId: message.channelId,
    messageId: message.id,
    contentPreview: message.content.substring(0, 100)
  }, 'Detected potential bug report in wrong channel');

  try {
    // Try to DM the user
    try {
      const dmMessage = createBugRedirectMessage(config.bugReportChannelId);
      await message.author.send(dmMessage);
      logger.info({ userId: message.author.id }, 'Sent DM redirect to user');
    } catch (dmError) {
      // User might have DMs disabled, that's okay
      logger.warn({ userId: message.author.id, error: dmError }, 'Could not DM user');

      // Reply in channel instead (will be deleted with the message, but user might see it)
      try {
        const reply = await message.reply({
          content: `<@${message.author.id}> This looks like a bug report! Please use the **New Bug Report** button in <#${config.bugReportChannelId}> instead.`,
          allowedMentions: { users: [message.author.id] }
        });

        // Delete the reply after a few seconds
        setTimeout(() => {
          reply.delete().catch(() => { });
        }, 10000);
      } catch (replyError) {
        logger.warn({ error: replyError }, 'Could not reply to message');
      }
    }

    // Delete the original message
    await message.delete();
    logger.info({ messageId: message.id }, 'Deleted misplaced bug report');

  } catch (error) {
    logger.error({ error, messageId: message.id }, 'Failed to handle misplaced bug report');
  }
}
