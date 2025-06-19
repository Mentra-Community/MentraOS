import express from 'express';
import sessionService from '../services/session/session.service';
import { Request, Response, NextFunction } from 'express';
import appService from '../services/core/app.service';
import { logger as rootLogger } from '../services/logging/pino-logger';
const logger = rootLogger.child({ service: 'audio.routes' });

const router = express.Router();

// Only allow com.augmentos.shazam
const ALLOWED_PACKAGE = 'com.augmentos.shazam';
const IS_LC3 = false; // Set to true if LC3 decoding is needed

async function shazamAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.query.apiKey as string;
  const packageName = req.query.packageName as string;
  const userId = req.query.userId as string;

  if (apiKey && packageName && userId) {
    if (packageName !== ALLOWED_PACKAGE) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized package name'
      });
    }
    // Validate the API key for the specified package
    const isValid = await appService.validateApiKey(packageName, apiKey);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key.'
      });
    }
    (req as any).userSession = { userId, minimal: true, apiKeyAuth: true };
    return next();
  }

  return res.status(401).json({
    success: false,
    message: 'Authentication required. Provide apiKey, packageName, and userId.'
  });
}

// TODO(isaiah): Improve audio manager to handle logic for getting the last 10 seconds of audio and decoding it if necessary.
// GET /api/audio/:sessionId
// Returns the last 10 seconds of audio for the session as a binary buffer (decoded to PCM if LC3)
router.get('/api/audio/:userId', shazamAuthMiddleware, async (req, res) => {
  try {
    const userId = req.params.userId;
    const userSession = sessionService.getSessionByUserId(userId);

    if (!userSession) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!userSession.recentAudioBuffer || userSession.recentAudioBuffer.length === 0) {
      return res.status(404).json({ error: 'No audio available' });
    }

    let buffers: Buffer[] = [];
    // The code below will may cause issues with the LC3 decoding, so it is commented out for now because we are not using LC3 yet.
    // if (IS_LC3 && userSession.audioManager.lc3Service) {
    //   // Decode each chunk to PCM
    //   for (const chunk of userSession.recentAudioBuffer) {
    //     try {
    //       // decodeAudioChunk may be async
    //       const decoded = await userSession.lc3Service.decodeAudioChunk(chunk.data);
    //       if (decoded) {
    //         buffers.push(Buffer.from(decoded));
    //       }
    //     } catch (err) {
    //       logger.error('Error decoding LC3 chunk:', err);
    //     }
    //   }
    // } else {
    //   // Not LC3, just use the raw data
    //   buffers = userSession.recentAudioBuffer.map(chunk => Buffer.from(chunk.data));
    // }

    buffers = userSession.audioManager.getRecentAudioBuffer().map(chunk => Buffer.from(chunk.data));

    if (buffers.length === 0) {
      return res.status(404).json({ error: 'No decodable audio available' });
    }
    const audioBuffer = Buffer.concat(buffers);
    res.set('Content-Type', 'application/octet-stream');
    res.send(audioBuffer);
  } catch (error) {
    logger.error('Error fetching audio:', error);
    res.status(500).json({ error: 'Error fetching audio' });
  }
});

export default router; 