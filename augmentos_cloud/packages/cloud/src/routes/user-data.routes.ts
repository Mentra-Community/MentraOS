import express from 'express';
import sessionService from '../services/core/session.service';
import { StreamType } from '@augmentos/sdk';
import subscriptionService from '../services/core/subscription.service';
import { CloudToTpaMessageType } from '@augmentos/sdk';

const router = express.Router();

// POST /api/user-data/set-datetime
// Body: { userId: string, datetime: string (ISO format) }
router.post('/set-datetime', (req, res) => {
  const { userId, datetime } = req.body;
  console.log('Setting datetime for user', userId, datetime);
  if (!userId || !datetime || isNaN(Date.parse(datetime))) {
    return res.status(400).json({ error: 'Missing or invalid userId or datetime (must be ISO string)' });
  }
  const userSession = sessionService.getSessionByUserId(userId);
  if (!userSession) {
    return res.status(404).json({ error: 'User session not found' });
  }
  // Store the datetime in the session (custom property)
  userSession.userDatetime = datetime;
  console.log('User session updated', userSession.userDatetime);

  // Relay custom_message to all TPAs subscribed to custom_message
  if (userSession.appConnections) {
    const subscribedApps = subscriptionService.getSubscribedApps(userSession, StreamType.CUSTOM_MESSAGE);

    console.log('4343 Subscribed apps', subscribedApps);
    const customMessage = {
      type: CloudToTpaMessageType.CUSTOM_MESSAGE,
      action: 'update_datetime',
      payload: {
        datetime: datetime,
        section: 'topLeft'
      },
      timestamp: new Date()
    };
    for (const packageName of subscribedApps) {
      const ws = userSession.appConnections.get(packageName);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(customMessage));
      }
    }
  }

  res.json({ success: true, userId, datetime });
});

export default router; 