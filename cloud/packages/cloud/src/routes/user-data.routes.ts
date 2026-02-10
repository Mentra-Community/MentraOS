import express from "express";
import UserSession from "../services/session/UserSession";
import { StreamType } from "@mentra/sdk";
// import subscriptionService from '../services/session/subscription.service';
import { CloudToAppMessageType } from "@mentra/sdk";
import jwt from "jsonwebtoken";

const router = express.Router();

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;
if (!AUGMENTOS_AUTH_JWT_SECRET) {
  throw new Error(
    "AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables",
  );
}

// POST /api/user-data/set-datetime
// Body: { coreToken: string, datetime: string (ISO format) }
router.post("/set-datetime", (req, res) => {
  const { coreToken, datetime } = req.body;
  console.log("Setting datetime with core token", datetime);

  if (!coreToken || !datetime || isNaN(Date.parse(datetime))) {
    return res
      .status(400)
      .json({
        error: "Missing or invalid coreToken or datetime (must be ISO string)",
      });
  }

  try {
    // Verify and decode the core token to extract userId
    const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET);
    const userId = (userData as jwt.JwtPayload).email;

    if (!userId) {
      return res
        .status(401)
        .json({ error: "Invalid core token - missing user email" });
    }

    console.log("Setting datetime for user", userId, datetime);

    const userSession = UserSession.getById(userId);
    if (!userSession) {
      return res.status(404).json({ error: "User session not found" });
    }

    // Store the datetime in the session (custom property)
    userSession.userDatetime = datetime;
    console.log("User session updated", userSession.userDatetime);

    // Relay custom_message to all Apps subscribed to custom_message
    const subscribedApps = userSession.subscriptionManager.getSubscribedApps(
      StreamType.CUSTOM_MESSAGE,
    );

    console.log("4343 Subscribed apps", subscribedApps);
    const customMessage = {
      type: CloudToAppMessageType.CUSTOM_MESSAGE,
      action: "update_datetime",
      payload: {
        datetime: datetime,
        section: "topLeft",
      },
      timestamp: new Date(),
    };
    for (const packageName of subscribedApps) {
      const appWebsocket = userSession.appWebsockets.get(packageName);
      if (appWebsocket && appWebsocket.readyState === 1) {
        appWebsocket.send(JSON.stringify(customMessage));
      }
    }

    res.json({ success: true, userId, datetime });
  } catch (error) {
    console.error("Error verifying core token:", error);
    return res.status(401).json({ error: "Invalid or expired core token" });
  }
});

export default router;
