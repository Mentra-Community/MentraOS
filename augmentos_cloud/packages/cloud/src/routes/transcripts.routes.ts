//backend/src/routes/apps.ts
import express from 'express';
import sessionService from '../services/session/session.service';
import { TranscriptSegment } from '@mentra/sdk';
const router = express.Router();

// GET /api/transcripts/:appSessionId
// Headers:
//   - X-API-Key: <tpa-api-key>
//   - X-Package-Name: <tpa-package-name>
// Query Parameters:
//   - duration: number (seconds to look back)
//   - startTime?: ISO timestamp (optional alternative to duration)
//   - endTime?: ISO timestamp (optional alternative to duration)
//   - language?: string (language code, e.g. 'en-US', 'fr-FR', defaults to 'en-US')

// Get all available apps
router.get('/api/transcripts/:appSessionId', async (req, res) => {
  try {
    const appSessionId = req.params.appSessionId;
    const duration = req.query.duration;
    const startTime = req.query.startTime;
    const endTime = req.query.endTime;
    const language = (req.query.language as string) || 'en-US';

    console.log(`🔍 Fetching transcripts for session ${appSessionId}, language: ${language}`);

    if (!duration && !startTime && !endTime) {
      return res.status(400).json({ error: 'duration, startTime, or endTime is required' });
    }

    const userSessionId = appSessionId.split('-')[0];
    const userSession = sessionService.getSession(userSessionId);
    if (!userSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    let transcriptSegments: TranscriptSegment[] = [];

    // Check if we have language-specific segments
    if (userSession.transcript.languageSegments?.has(language)) {
      console.log(`✅ Found language-specific segments for ${language}`);
      transcriptSegments = userSession.transcript.languageSegments.get(language) || [];
    } else if (language === 'en-US') {
      // Fallback to legacy segments for English
      console.log('⚠️ Using legacy segments for en-US');
      transcriptSegments = userSession.transcript.segments;
    } else {
      console.log(`⚠️ No segments found for language ${language}`);
      // Return empty array for languages we don't have
    }

    // Apply time-based filtering
    const filteredTranscriptSegments = transcriptSegments.filter((segment: TranscriptSegment) => {
      const segmentTime = new Date(segment.timestamp);
      const currentTime = new Date();
      const secondsSinceNow = (currentTime.getTime() - segmentTime.getTime()) / 1000;

      if (duration) {
        const durationSeconds = parseInt(duration as string);
        return secondsSinceNow <= durationSeconds;
      }

      // TODO: Add handling for startTime/endTime filters
      return true;
    });

    console.log(`💬 Returning ${filteredTranscriptSegments.length} transcript segments for language ${language}`);

    res.json({
      language: language,
      segments: filteredTranscriptSegments
    });

  } catch (error) {
    console.error('Error fetching transcripts:', error);
    res.status(500).json({ error: 'Error fetching transcripts' });
  }
});

export default router;