import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits
} from 'discord.js';
import { bugReportStore } from '../services/bug-report-store';
import { logger } from '../services/logger';

export const lookupEmailCommand = new SlashCommandBuilder()
  .setName('lookup-email')
  .setDescription('Look up the email for a bug report (mod only)')
  .addStringOption(option =>
    option
      .setName('thread-id')
      .setDescription('The thread ID or URL of the bug report')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);

export async function handleLookupEmailCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const input = interaction.options.getString('thread-id', true);

  // Extract thread ID from URL if provided
  let threadId = input;

  // Handle full URLs like https://discord.com/channels/123/456/789
  const urlMatch = input.match(/channels\/\d+\/(\d+)/);
  if (urlMatch) {
    threadId = urlMatch[1];
  }

  // Handle thread mention format
  const mentionMatch = input.match(/<#(\d+)>/);
  if (mentionMatch) {
    threadId = mentionMatch[1];
  }

  logger.info({
    userId: interaction.user.id,
    threadId
  }, 'Email lookup requested');

  const report = bugReportStore.get(threadId);

  if (!report) {
    await interaction.reply({
      content: `No bug report data found for thread ID: ${threadId}\n\nNote: Only reports created through the bot button are tracked.`,
      ephemeral: true
    });
    return;
  }

  if (!report.email) {
    await interaction.reply({
      content: `**Bug Report Info**\nThread: <#${threadId}>\nReported by: ${report.username}\nCreated: ${report.createdAt.toISOString()}\n\n**No email was provided for this report.**`,
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: `**Bug Report Info**\nThread: <#${threadId}>\nReported by: ${report.username}\nCreated: ${report.createdAt.toISOString()}\n\n**Email:** \`${report.email}\``,
    ephemeral: true
  });
}
