import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  ForumChannel,
  PermissionFlagsBits,
  EmbedBuilder,
  TextChannel
} from 'discord.js';
import { createBugReportButton } from './bug-report';
import { logger } from '../services/logger';

export const setupCommand = new SlashCommandBuilder()
  .setName('setup-bug-reports')
  .setDescription('Set up the bug report button in a text channel (for forum channels, post this in an announcement channel)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function handleSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;

  if (!channel) {
    await interaction.reply({
      content: 'Could not determine the channel. Please try again.',
      ephemeral: true
    });
    return;
  }

  try {
    // Create the instruction message with button
    const embed = new EmbedBuilder()
      .setTitle('Bug Reports')
      .setDescription(
        `**Bug reports without required info will be closed.**

To report a bug:
1. Click the **New Bug Report** button below
2. Fill out the form (email is private and optional)
3. We'll follow up if needed

**Tip:** Reports submitted via the in-app feedback form include logs and are faster to debug!`
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Posts without required info may be marked low priority' });

    const button = createBugReportButton();

    // Reply with the setup message
    await interaction.reply({
      content: 'Bug report system ready! Copy this message to pin it in your forum channel guidelines:',
      embeds: [embed],
      components: [button]
    });

    logger.info({
      channelId: channel.id,
      guildId: interaction.guildId
    }, 'Bug report system set up');

  } catch (error) {
    logger.error({ error }, 'Failed to set up bug reports');
    await interaction.reply({
      content: 'Failed to set up bug reports. Please check bot permissions.',
      ephemeral: true
    });
  }
}

/**
 * Suggest tags to add to the forum channel for better organization
 */
export function getSuggestedTags(): { name: string; emoji?: string }[] {
  return [
    { name: 'Has Email' },
    { name: 'No Email' },
    { name: 'iOS' },
    { name: 'Android' },
    { name: 'G1 Glasses' },
    { name: 'Meta Ray-Ban' },
    { name: 'In Progress' },
    { name: 'Resolved' },
    { name: 'Need More Info' }
  ];
}
