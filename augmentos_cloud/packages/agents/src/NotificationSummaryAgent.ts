import { Agent } from "./AgentInterface";
import { PromptTemplate } from "@langchain/core/prompts";
import { HumanMessage } from "@langchain/core/messages";
import { LLMProvider } from "@mentra/utils";

// Define interfaces for notifications and response
export interface NotificationRank {
  uuid: string;
  summary: string;
  rank: number;
  appName?: string;
  title?: string;
  text?: string;
  timestamp?: string;
}

export interface NotificationFilterResponse {
  notification_ranking: NotificationRank[];
}

const agentPromptBlueprint = `You are an assistant on smart glasses that filters the notifications the user receives on their phone by importance and provides a concise summary for the HUD display.

Your output **must** be a valid JSON object with one key:
"notification_ranking" — an array of notifications, ordered from most important (rank=1) to least important (rank=10).

For each notification in the output array:
  1. Include the notification "uuid".
  2. Include a short "summary" that captures the most important points from the title, body, and (optionally) the appName if it provides relevant context (e.g., times, tasks, or key details). The summary must be under 30 characters.
  3. If the notification title contains a name, the "summary" must include the summarized name of the sender (e.g., only their first name) or the relevant individual mentioned. Do not include the name of the group chat in the summary.
  4. If a notification contains inappropriate, offensive, or NSFW content, include it in the output, but the summary must be in the format: '<person>: inappropriate comment', where <person> is the sender's name if available, otherwise use 'Unknown'. Do not include any details of the inappropriate content in the summary.
  5. Include a "rank" integer between 1 and 10 (where 1 = highest importance, 10 = lowest).

Criteria of Importance:
  - Urgent tasks, deadlines, and time-sensitive events are ranked higher.
  - Notifications that mention deadlines, reminders, or critical alerts should be given the highest priority.
  - Personal messages from known contacts (indicated by a name in the title) should be prioritized over generic system notifications.
  - Exclude any system notifications that aren't related to low phone battery.
  - Ensure the output list does not include duplicate or overly similar notifications.
  - Prioritize notifications that are more recent over older notifications.

Sorting:
  - The output array must be sorted so that rank=1 is the first item, rank=2 is the second, and so on.

Example Output:
{{
  "notification_ranking": [
    {{
      "uuid": "123-xyz",
      "summary": "Submit proposal by midnight",
      "rank": 1
    }},
    {{
      "uuid": "456-abc",
      "summary": "Alex: party on Sunday?",
      "rank": 2
    }},
    {{
      "uuid": "789-def",
      "summary": "Sam: inappropriate comment",
      "rank": 3
    }}
  ]
}}

Input (JSON):
{notifications}`;

export class NotificationSummaryAgent implements Agent {
  public agentId = "notification_summary";
  public agentName = "NotificationSummaryAgent";
  public agentDescription =
    "Summarizes notifications by importance and provides concise summaries for display on smart glasses.";
  public agentPrompt = agentPromptBlueprint;
  // This agent doesn't use additional tools.
  public agentTools: any[] = [];

  /**
   * Parses the LLM output expecting a valid JSON string with key "notification_ranking".
   */
  private parseOutput(text: string): NotificationFilterResponse {
    // Remove Markdown code block markers if they exist.
    // For example, if text starts with "```json" and ends with "```"
    const trimmedText = text.trim();
    let jsonText = trimmedText;
    if (trimmedText.startsWith("```")) {
      // Remove the starting code fence (e.g., ```json)
      const firstLineBreak = trimmedText.indexOf("\n");
      if (firstLineBreak !== -1) {
        jsonText = trimmedText.substring(firstLineBreak).trim();
      }
      // Remove the trailing code fence if it exists.
      if (jsonText.endsWith("```")) {
        jsonText = jsonText.substring(0, jsonText.length - 3).trim();
      }
    }

    try {
      const parsed: NotificationFilterResponse = JSON.parse(jsonText);
      if (
        parsed &&
        Array.isArray(parsed.notification_ranking) &&
        parsed.notification_ranking.every(
          (n) =>
            typeof n.uuid === "string" &&
            typeof n.summary === "string" &&
            typeof n.rank === "number"
        )
      ) {
        return parsed;
      }
    } catch (e) {
      console.error("Failed to parse LLM output:", e);
    }
    // Return an empty ranking if parsing fails.
    return { notification_ranking: [] };
  }

  /**
   * Handles the context which is expected to include a "notifications" field (an array).
   */
  public async handleContext(
    userContext: Record<string, any>
  ): Promise<any> {
    try {
      let notifications: any[] = userContext.notifications;
      if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
        return [];
      }

      // Convert timestamps if they are in milliseconds (number) to a readable string.
      notifications = notifications.map((notification) => {
        if (notification.timestamp && typeof notification.timestamp === "number") {
          // Convert from ms to a readable UTC string.
          notification.timestamp = new Date(notification.timestamp)
            .toISOString();
        }
        // Clean title, content, and text fields of emojis and non-ASCII characters
        const clean = (str: string) => typeof str === 'string' ? str.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F]|[^\x00-\x7F]/gu, '') : str;
        notification.title = clean(notification.title);
        notification.content = clean(notification.content);
        notification.text = clean(notification.text);
        return notification;
      });

      // Convert notifications array to a JSON string.
      const notificationsStr = JSON.stringify(notifications, null, 2);

      // Prepare the prompt using the notifications string.
      const promptTemplate = new PromptTemplate({
        template: this.agentPrompt,
        inputVariables: ["notifications"],
      });

      const finalPrompt = await promptTemplate.format({
        notifications: notificationsStr
      });
      // Initialize LLM with settings.
      const llmOptions: any = {};
      llmOptions.responseFormat = { type: "json_object" };
      const llm = LLMProvider.getLLM(llmOptions);

      // Call the LLM.
      const response = await llm.invoke(finalPrompt);

      // Expect the LLM response to have a "content" property.
      if (!response || !response.content) {
        // Fallback: return original notifications with default summary/rank
        return notifications.map((n) => ({
          uuid: n.uuid,
          summary: (n.title + ": " + n.text || "").substring(0, 30),
          rank: 10,
          appName: n.appName || "",
          title: n.title || "",
          text: n.text || "",
          timestamp: n.timestamp || "",
        }));
      }

      const content = typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content[0].type === 'text'
            ? response.content[0].text
            : ''
          : '';

      const parsedOutput = this.parseOutput(content);
      const rankingList = parsedOutput.notification_ranking;

      // If parsing failed or rankingList is empty, fallback to original notifications
      if (!rankingList || rankingList.length === 0) {
        return notifications.map((n) => ({
          uuid: n.uuid,
          summary: (n.title + ": " + n.text || "").substring(0, 30),
          rank: 10,
          appName: n.appName || "",
          title: n.title || "",
          text: n.text || "",
          timestamp: n.timestamp || "",
        }));
      }

      // Create a lookup of original notifications by uuid.
      const notificationsMap: { [key: string]: any } = {};
      notifications.forEach((n) => {
        notificationsMap[n.uuid] = n;
      });

      // Enrich each ranked notification with additional fields from the original notification.
      const enrichedRankingList = rankingList.map((rank) => {
        const original = notificationsMap[rank.uuid] || {};
        return {
          ...rank,
          appName: original.appName || "",
          title: original.title || "",
          text: original.text || "",
          timestamp: original.timestamp || "",
        };
      });

      // console.log("RANKING LIST:");
      console.log(enrichedRankingList);
      return enrichedRankingList;
    } catch (err) {
      console.error("[NotificationSummaryAgent] Error:", err);
      // Fallback: return original notifications with default summary/rank
      let notifications: any[] = userContext.notifications;
      if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
        return [];
      }
      notifications = notifications.map((notification) => {
        if (notification.timestamp && typeof notification.timestamp === "number") {
          notification.timestamp = new Date(notification.timestamp)
            .toISOString()
            .replace("T", " ")
            .substring(0, 19);
        }
        return notification;
      });
      return notifications.map((n) => ({
        uuid: n.uuid,
        summary: (n.title + ": " + n.text || "").substring(0, 30),
        rank: 10,
        appName: n.appName || "",
        title: n.title || "",
        text: n.text || "",
        timestamp: n.timestamp || "",
      }));
    }
  }
}
