import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ForumChannel,
  ChannelType,
  ThreadChannel
} from 'discord.js';
import { BugReportData } from '../types/config';
import { bugReportStore } from '../services/bug-report-store';
import { logger } from '../services/logger';

// Modal IDs
export const BUG_REPORT_BUTTON_ID = 'bug_report_button';
export const BUG_REPORT_MODAL_ID = 'bug_report_modal';

// Input IDs
const INPUT_WHAT_HAPPENED = 'what_happened';
const INPUT_WHAT_SHOULD_HAPPEN = 'what_should_happen';
const INPUT_STEPS_TO_REPRODUCE = 'steps_to_reproduce';
const INPUT_PLATFORM_AND_DEVICE = 'platform_and_device';
const INPUT_EMAIL = 'email';

/**
 * Creates the "New Bug Report" button to be posted in the forum channel
 */
export function createBugReportButton(): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(BUG_REPORT_BUTTON_ID)
    .setLabel('New Bug Report')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('🐛');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Creates the bug report modal when the button is clicked
 */
export function createBugReportModal(): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(BUG_REPORT_MODAL_ID)
    .setTitle('Report a Bug');

  const whatHappenedInput = new TextInputBuilder()
    .setCustomId(INPUT_WHAT_HAPPENED)
    .setLabel('What happened?')
    .setPlaceholder('Describe the bug you encountered...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  const whatShouldHappenInput = new TextInputBuilder()
    .setCustomId(INPUT_WHAT_SHOULD_HAPPEN)
    .setLabel('What should have happened?')
    .setPlaceholder('Describe the expected behavior...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500);

  const stepsInput = new TextInputBuilder()
    .setCustomId(INPUT_STEPS_TO_REPRODUCE)
    .setLabel('Steps to reproduce (optional)')
    .setPlaceholder('1. Open the app\n2. Tap on...\n3. Bug appears')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  const platformInput = new TextInputBuilder()
    .setCustomId(INPUT_PLATFORM_AND_DEVICE)
    .setLabel('Platform & Device Info')
    .setPlaceholder('e.g., iOS 17 / iPhone 15, Even Realities G1')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(200);

  const emailInput = new TextInputBuilder()
    .setCustomId(INPUT_EMAIL)
    .setLabel('Email used for Mentra (private, optional)')
    .setPlaceholder('your@email.com (helps us find your logs)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);

  // Add inputs to action rows (max 5 per modal)
  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(whatHappenedInput);
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(whatShouldHappenInput);
  const row3 = new ActionRowBuilder<TextInputBuilder>().addComponents(stepsInput);
  const row4 = new ActionRowBuilder<TextInputBuilder>().addComponents(platformInput);
  const row5 = new ActionRowBuilder<TextInputBuilder>().addComponents(emailInput);

  modal.addComponents(row1, row2, row3, row4, row5);

  return modal;
}

/**
 * Handle the bug report button click
 */
export async function handleBugReportButton(interaction: ButtonInteraction): Promise<void> {
  const modal = createBugReportModal();
  await interaction.showModal(modal);
}

/**
 * Parse the platform and device info from user input
 */
function parsePlatformInfo(input: string): { platform: string; phoneModel: string; glassesModel: string } {
  // Simple parsing - user provides free-form text
  const parts = input.split(/[,\/]/);

  let platform = 'Unknown';
  let phoneModel = 'Unknown';
  let glassesModel = 'Unknown';

  // Try to detect platform
  const lowerInput = input.toLowerCase();
  if (lowerInput.includes('ios') || lowerInput.includes('iphone') || lowerInput.includes('ipad')) {
    platform = 'iOS';
  } else if (lowerInput.includes('android')) {
    platform = 'Android';
  }

  // Try to detect glasses
  if (lowerInput.includes('g1') || lowerInput.includes('even realities')) {
    glassesModel = 'Even Realities G1';
  } else if (lowerInput.includes('frame') || lowerInput.includes('brilliant')) {
    glassesModel = 'Brilliant Frame';
  } else if (lowerInput.includes('meta') || lowerInput.includes('ray-ban') || lowerInput.includes('rayban')) {
    glassesModel = 'Meta Ray-Ban';
  }

  // Use the full input as phone model if we can't parse it
  phoneModel = input.trim();

  return { platform, phoneModel, glassesModel };
}

/**
 * Handle the bug report modal submission
 */
export async function handleBugReportModalSubmit(
  interaction: ModalSubmitInteraction,
  bugReportChannelId: string
): Promise<void> {
  const whatHappened = interaction.fields.getTextInputValue(INPUT_WHAT_HAPPENED);
  const whatShouldHappen = interaction.fields.getTextInputValue(INPUT_WHAT_SHOULD_HAPPEN);
  const stepsToReproduce = interaction.fields.getTextInputValue(INPUT_STEPS_TO_REPRODUCE) || 'Not provided';
  const platformInfo = interaction.fields.getTextInputValue(INPUT_PLATFORM_AND_DEVICE);
  const email = interaction.fields.getTextInputValue(INPUT_EMAIL)?.trim() || null;

  const { platform, phoneModel, glassesModel } = parsePlatformInfo(platformInfo);

  const bugReportData: BugReportData = {
    whatHappened,
    whatShouldHappen,
    stepsToReproduce,
    platform,
    phoneModel,
    glassesModel,
    email,
    noEmailProvided: !email
  };

  try {
    // Get the bug report forum channel
    const channel = await interaction.client.channels.fetch(bugReportChannelId);

    if (!channel || channel.type !== ChannelType.GuildForum) {
      logger.error({ channelId: bugReportChannelId }, 'Bug report channel is not a forum channel');
      await interaction.reply({
        content: 'Error: Bug report channel is misconfigured. Please contact an admin.',
        ephemeral: true
      });
      return;
    }

    const forumChannel = channel as ForumChannel;

    // Create the public embed (without email)
    const embed = createPublicBugReportEmbed(bugReportData, interaction.user.username);

    // Determine the tag for priority
    const tags: string[] = [];

    // Try to find existing tags or create appropriate ones
    const availableTags = forumChannel.availableTags;
    const noEmailTag = availableTags.find(t => t.name.toLowerCase().includes('no email') || t.name.toLowerCase().includes('limited'));
    const hasEmailTag = availableTags.find(t => t.name.toLowerCase().includes('has email') || t.name.toLowerCase().includes('full'));
    const platformTag = availableTags.find(t => t.name.toLowerCase() === platform.toLowerCase());

    if (email && hasEmailTag) {
      tags.push(hasEmailTag.id);
    } else if (!email && noEmailTag) {
      tags.push(noEmailTag.id);
    }

    if (platformTag) {
      tags.push(platformTag.id);
    }

    // Create a title from the bug description
    const title = whatHappened.length > 100
      ? whatHappened.substring(0, 97) + '...'
      : whatHappened;

    // Create the forum thread
    const thread = await forumChannel.threads.create({
      name: title,
      message: {
        embeds: [embed]
      },
      appliedTags: tags.length > 0 ? tags : undefined
    });

    // Store the private data (email) linked to thread ID
    bugReportStore.store(thread.id, {
      ...bugReportData,
      threadId: thread.id,
      userId: interaction.user.id,
      username: interaction.user.username,
      createdAt: new Date()
    });

    // Send success response
    const priorityNote = email
      ? ''
      : '\n\n**Note:** No email was provided, so debugging may be limited.';

    await interaction.reply({
      content: `Bug report created! ${thread.url}${priorityNote}`,
      ephemeral: true
    });

    logger.info({
      threadId: thread.id,
      userId: interaction.user.id,
      hasEmail: !!email
    }, 'Bug report created');

  } catch (error) {
    logger.error({ error }, 'Failed to create bug report');
    await interaction.reply({
      content: 'Failed to create bug report. Please try again or contact an admin.',
      ephemeral: true
    });
  }
}

/**
 * Create the public embed for the bug report (without email)
 */
function createPublicBugReportEmbed(data: BugReportData, username: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Bug Report')
    .setColor(data.noEmailProvided ? 0xFFA500 : 0x00FF00) // Orange if no email, green if has email
    .setTimestamp()
    .setFooter({ text: `Reported by ${username}` });

  embed.addFields(
    { name: 'What happened?', value: data.whatHappened },
    { name: 'Expected behavior', value: data.whatShouldHappen },
    { name: 'Steps to reproduce', value: data.stepsToReproduce || 'Not provided' },
    { name: 'Platform', value: data.platform, inline: true },
    { name: 'Device', value: data.phoneModel, inline: true },
    { name: 'Glasses', value: data.glassesModel, inline: true }
  );

  if (data.noEmailProvided) {
    embed.addFields({
      name: '**Debug Status**',
      value: 'No email provided - debugging may be limited'
    });
  } else {
    embed.addFields({
      name: '**Debug Status**',
      value: 'Email provided - full debugging available'
    });
  }

  return embed;
}
