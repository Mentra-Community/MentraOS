export interface BotConfig {
  token: string;
  clientId: string;
  guildId: string;
  bugReportChannelId: string;
  watchedChannelIds: string[];
}

export interface BugReportData {
  whatHappened: string;
  whatShouldHappen: string;
  stepsToReproduce: string;
  platform: string;
  phoneModel: string;
  glassesModel: string;
  email: string | null;
  noEmailProvided: boolean;
}

export interface StoredBugReport extends BugReportData {
  threadId: string;
  userId: string;
  username: string;
  createdAt: Date;
}
