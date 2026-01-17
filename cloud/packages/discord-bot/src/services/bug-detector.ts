import { Message } from 'discord.js';
import { logger } from './logger';

// Keywords that suggest a bug report
const BUG_KEYWORDS = [
  'bug',
  'broken',
  'crash',
  'crashed',
  'crashing',
  'doesn\'t work',
  'doesnt work',
  'not working',
  'stopped working',
  'won\'t',
  'wont',
  'can\'t',
  'cant',
  'error',
  'issue',
  'problem',
  'failed',
  'failing',
  'freeze',
  'frozen',
  'froze',
  'stuck',
  'glitch',
  'glitchy',
  'laggy',
  'lag',
  'slow',
  'unresponsive',
  'black screen',
  'white screen',
  'disconnected',
  'disconnect',
  'won\'t connect',
  'can\'t connect',
  'not connecting'
];

// Regex patterns for bug-like language
const BUG_PATTERNS = [
  /\b(app|glasses|phone|device)\s+(crash|broke|stopped|froze|died)/i,
  /\b(keeps?|always|constantly)\s+(crash|break|stop|freez)/i,
  /\bnot\s+(work|connect|show|display|play)/i,
  /\b(why|how come)\s+(is|does|doesn't|doesnt|won't|wont|can't|cant)/i,
  /\b(help|please)\b.*(bug|crash|broke|error|issue|problem)/i
];

/**
 * Check if a message appears to be a bug report
 */
export function isBugReport(message: Message): boolean {
  const content = message.content.toLowerCase();

  // Check for bug keywords
  for (const keyword of BUG_KEYWORDS) {
    if (content.includes(keyword)) {
      logger.debug({ keyword, messageId: message.id }, 'Bug keyword detected');
      return true;
    }
  }

  // Check for bug patterns
  for (const pattern of BUG_PATTERNS) {
    if (pattern.test(content)) {
      logger.debug({ pattern: pattern.source, messageId: message.id }, 'Bug pattern detected');
      return true;
    }
  }

  // Check if message has attachments (screenshots/recordings) and mentions issues
  if (message.attachments.size > 0) {
    // If there's media + any issue-related language
    const issueLanguage = [
      'help', 'look', 'see', 'check', 'what', 'why', 'how',
      'this', 'happen', 'wrong', 'weird', 'strange'
    ];

    for (const word of issueLanguage) {
      if (content.includes(word)) {
        logger.debug({ messageId: message.id }, 'Media with issue language detected');
        return true;
      }
    }

    // If there's just an image/video with no text, it might be a bug screenshot
    if (content.length < 50) {
      const hasImageOrVideo = message.attachments.some(att =>
        att.contentType?.startsWith('image/') || att.contentType?.startsWith('video/')
      );

      if (hasImageOrVideo) {
        logger.debug({ messageId: message.id }, 'Short message with media detected');
        return true;
      }
    }
  }

  return false;
}

/**
 * Create the DM message to send when a bug is detected in wrong channel
 */
export function createBugRedirectMessage(bugReportChannelId: string): string {
  return `Hey! It looks like you might be reporting a bug.

**Bug reports should go in <#${bugReportChannelId}>** using the **New Bug Report** button.

This ensures we have all the info needed to debug your issue. The in-app feedback form is even better because it includes logs automatically!

Your message has been removed from the channel to keep things organized. Please re-submit using the bug report form.`;
}

/**
 * Create the reason for audit log when deleting a misplaced bug report
 */
export function createDeletionReason(): string {
  return 'Misplaced bug report - user redirected to #bug-reports';
}
