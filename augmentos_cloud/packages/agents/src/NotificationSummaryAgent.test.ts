import { test } from "bun:test";
import { NotificationSummaryAgent } from "./NotificationSummaryAgent";

const agent = new NotificationSummaryAgent();

// Helper: generates a notification
function makeNotification({ uuid, title, text, appName, timestamp }: any) {
  return {
    uuid,
    title,
    text,
    appName,
    timestamp,
  };
}

// 1. Test: normal notifications with different priorities
test("NotificationSummaryAgent ranks and summarizes notifications by importance", async () => {
  const notifications = [
    makeNotification({
      uuid: "4",
      title: "Alex: party on Sunday?",
      text: "Are you coming to the party?",
      appName: "Messenger",
      timestamp: Date.now() - 10000,
    }),
    makeNotification({
      uuid: "2",
      title: "Battery low",
      text: "Your phone battery is below 20%.",
      appName: "System",
      timestamp: Date.now() - 5000,
    }),
    makeNotification({
      uuid: "3",
      title: "Reminder: Submit proposal by midnight",
      text: "Don't forget the deadline!",
      appName: "Calendar",
      timestamp: Date.now() - 20000,
    }),
    makeNotification({
      uuid: "1",
      title: "Auki <> Mentra: Nicolo",
      text: "Thanks, I talked to Charlie, I can sync with him if that works. Do you have his WhatsApp?",
      appName: "System",
      timestamp: Date.now() - 3000,
    }),
  ];

  const result = await agent.handleContext({ notifications });

  // Should return an array with at least the most important notifications
  if (!Array.isArray(result)) throw new Error("Result is not an array");
  if (result.length < 2) throw new Error("Should return at least 2 notifications");

  // Check that each has uuid, summary, rank
  for (const n of result) {
    if (!n.uuid || typeof n.summary !== "string" || typeof n.rank !== "number") {
      throw new Error("Missing required fields in output");
    }
    if (n.summary.length > 30) {
      throw new Error(`Summary too long: ${n.summary}`);
    }
  }

  // Check that the most important notification is ranked 1
  if (result[0].rank !== 1) throw new Error("First notification should have rank 1");

  console.log("###result", result);

  // Check that the output is sorted by rank
  for (let i = 1; i < result.length; ++i) {
    if (result[i].rank < result[i - 1].rank) {
      throw new Error("Notifications not sorted by rank");
    }
  }
});

// 2. Test: empty notification list
test("NotificationSummaryAgent returns empty array for empty input", async () => {
  const result = await agent.handleContext({ notifications: [] });
  if (!Array.isArray(result)) throw new Error("Result is not an array");
  if (result.length !== 0) throw new Error("Result should be empty for empty input");
});

// 3. Test: notification with ms timestamp
test("NotificationSummaryAgent handles ms timestamps", async () => {
  const notifications = [
    makeNotification({
      uuid: "5",
      title: "Reminder: Dentist appointment",
      text: "Tomorrow at 9am",
      appName: "Calendar",
      timestamp: Date.now(),
    }),
  ];
  const result = await agent.handleContext({ notifications });
  if (!Array.isArray(result)) throw new Error("Result is not an array");
  if (result.length === 0) throw new Error("Should return at least one notification");
  if (typeof result[0].timestamp !== "string") throw new Error("Timestamp should be a string");
}); 