/**
 * Dash - Unified Content TPA
 * 
 * A consolidated TPA that provides different types of content to the AugmentOS dashboard
 * based on user settings. This replaces the separate content TPAs with a single
 * configurable application.
 */
import express from 'express';
import { 
  TpaSession,
  DashboardMode,
  StreamType
} from '@augmentos/sdk';
import { logger } from '@augmentos/utils';
import { 
  FunFactAgent, 
  FamousQuotesAgent, 
  GratitudePingAgent,
  NewsAgent,
  TrashTalkAgent,
  ChineseWordAgent
} from '@augmentos/agents';
import dotenv from 'dotenv';

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3100;
const CLOUD_HOST_NAME = process.env.CLOUD_LOCAL_HOST_NAME || "cloud";
const PACKAGE_NAME = "org.augmentos.dash";
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY;

if (!AUGMENTOS_API_KEY) {
  logger.error("API_KEY is not set. Please set the AUGMENTOS_API_KEY environment variable.");
  process.exit(1);
}

// Express app setup
const app = express();
app.use(express.json());

// Session management
interface SessionInfo {
  userId: string;
  session: TpaSession;
  contentHistory: {
    [contentType: string]: string[]
  };
  currentContent?: {
    type: string;
    content: string;
  };
  updateInterval?: NodeJS.Timeout;
  isActive: boolean;
  lastUpdateTime?: number;
  contentType?: string;
  contentFrequency?: number;
}

const activeSessions = new Map<string, SessionInfo>();

// Content update frequency (in milliseconds)
const DEFAULT_CONTENT_UPDATE_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Content type enum (matches settings options)
enum ContentType {
  NONE = 'none',
  FUN_FACTS = 'fun_facts',
  QUOTES = 'quotes',
  GRATITUDE = 'gratitude',
  NEWS = 'news',
  TRASH_TALK = 'trash_talk',
  CHINESE_WORDS = 'chinese_words'
}

// ==================================
// Webhook Endpoint - Entry Point
// ==================================
app.post('/webhook', async (req: express.Request, res: express.Response) => {
  try {
    const { sessionId, userId } = req.body;
    logger.info(`Session start for user ${userId}, session ${sessionId}`);

    // Clean up any existing session
    cleanupSession(sessionId);

    // Create new TPA session
    const session = new TpaSession({
      packageName: PACKAGE_NAME,
      apiKey: AUGMENTOS_API_KEY,
      augmentOSWebsocketUrl: `ws://${CLOUD_HOST_NAME}/tpa-ws`
    });

    // Store session info
    activeSessions.set(sessionId, {
      userId,
      session,
      contentHistory: {}, // Initialize empty history for each content type
      isActive: true,
      contentType: ContentType.NONE, // Default to none, will be updated from settings
      contentFrequency: DEFAULT_CONTENT_UPDATE_INTERVAL
    });

    // Connect to AugmentOS Cloud
    await session.connect(sessionId);
    logger.info(`Connected to AugmentOS Cloud for session ${sessionId}`);

    // Set up event handlers
    setupEventHandlers(sessionId, session);

    // Get settings and initialize content
    const contentType = session.settings.get('content_type', ContentType.NONE);
    const contentFrequency = session.settings.get('content_frequency', 10);
    
    const sessionInfo = activeSessions.get(sessionId);
    if (sessionInfo) {
      sessionInfo.contentType = contentType;
      sessionInfo.contentFrequency = contentFrequency * 60 * 1000; // Convert minutes to ms
      
      logger.info(`Session ${sessionId} settings: contentType=${contentType}, contentFrequency=${contentFrequency}min`);
      
      // Generate the first content after a short delay
      setTimeout(() => {
        generateAndSendContent(sessionId);
      }, 2000);
      
      // Start periodic content generation
      const updateInterval = setInterval(() => {
        generateAndSendContent(sessionId);
      }, sessionInfo.contentFrequency);
      
      sessionInfo.updateInterval = updateInterval;
    }

    // Respond to webhook
    res.status(200).json({ status: 'connected' });
  } catch (error) {
    logger.error('Error handling webhook', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================================
// Event Handlers
// ==================================
function setupEventHandlers(sessionId: string, session: TpaSession): void {
  // Handle head position using the proper SDK event handler
  session.onHeadPosition((data) => {
    if (data.position === 'up') {
      // Generate new content when the user looks up (if enough time has passed)
      const sessionInfo = activeSessions.get(sessionId);
      if (sessionInfo && sessionInfo.isActive && sessionInfo.contentType !== ContentType.NONE) {
        const lastUpdateTime = sessionInfo.lastUpdateTime || 0;
        const now = Date.now();
        if (now - lastUpdateTime > 30000) { // 30 seconds minimum between content updates
          generateAndSendContent(sessionId);
          sessionInfo.lastUpdateTime = now;
        }
      }
    }
  });

  // Listen for dashboard mode changes to adjust content
  session.dashboard.content.onModeChange((mode) => {
    logger.info(`Dashboard mode changed to ${mode} for session ${sessionId}`);
    
    if (mode === DashboardMode.EXPANDED) {
      const sessionInfo = activeSessions.get(sessionId);
      if (sessionInfo && sessionInfo.currentContent) {
        // For expanded mode, adapt the content as needed
        let expandedContent = sessionInfo.currentContent.content;
        
        // Prefix with content type if not already included
        if (!expandedContent.includes(sessionInfo.currentContent.type)) {
          expandedContent = `${sessionInfo.currentContent.type}: ${expandedContent}`;
        }
        
        session.dashboard.content.writeToExpanded(expandedContent);
      }
    }
  });

  // Handle settings changes
  session.settings.onValueChange('content_type', (newValue, oldValue) => {
    logger.info(`Content type changed from ${oldValue} to ${newValue} for session ${sessionId}`);
    
    const sessionInfo = activeSessions.get(sessionId);
    if (sessionInfo) {
      sessionInfo.contentType = newValue;
      
      // Generate new content immediately when setting changes
      generateAndSendContent(sessionId);
    }
  });
  
  session.settings.onValueChange('content_frequency', (newValue, oldValue) => {
    logger.info(`Content frequency changed from ${oldValue} to ${newValue} for session ${sessionId}`);
    
    const sessionInfo = activeSessions.get(sessionId);
    if (sessionInfo) {
      // Convert minutes to milliseconds
      const newFrequency = parseInt(newValue) * 60 * 1000;
      sessionInfo.contentFrequency = newFrequency;
      
      // Reset update interval with new frequency
      if (sessionInfo.updateInterval) {
        clearInterval(sessionInfo.updateInterval);
      }
      
      const updateInterval = setInterval(() => {
        generateAndSendContent(sessionId);
      }, newFrequency);
      
      sessionInfo.updateInterval = updateInterval;
    }
  });

  // Handle disconnection
  session.events.on('disconnected', (reason) => {
    logger.info(`Session ${sessionId} disconnected: ${reason}`);
    cleanupSession(sessionId);
  });
}

// ==================================
// Content Generation
// ==================================
async function generateAndSendContent(sessionId: string): Promise<void> {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo || !sessionInfo.isActive) return;
  
  // Skip content generation if type is none
  if (sessionInfo.contentType === ContentType.NONE) {
    logger.info(`Content type is set to 'none' for session ${sessionId}`);
    return;
  }

  try {
    // Ensure content type is defined
    if (!sessionInfo.contentType) {
      logger.warn(`Content type is undefined for session ${sessionId}`);
      return;
    }
    
    // Get history for this content type (or initialize if not exists)    
    if (!sessionInfo.contentHistory[sessionInfo.contentType]) {
      sessionInfo.contentHistory[sessionInfo.contentType] = [];
    }
    
    const history = sessionInfo.contentHistory[sessionInfo.contentType];
    
    // Generate content based on type
    let content: string | undefined;
    let contentTitle: string;
    
    switch (sessionInfo.contentType) {
      case ContentType.FUN_FACTS:
        contentTitle = "Fun Fact";
        content = await generateFunFact(history);
        break;
        
      case ContentType.QUOTES:
        contentTitle = "Quote";
        content = await generateQuote(history);
        break;
        
      case ContentType.GRATITUDE:
        contentTitle = "Gratitude";
        content = await generateGratitude(history);
        break;
        
      case ContentType.NEWS:
        contentTitle = "News";
        content = await generateNews(history);
        break;
        
      case ContentType.TRASH_TALK:
        contentTitle = "Trash Talk";
        content = await generateTrashTalk(history);
        break;
        
      case ContentType.CHINESE_WORDS:
        contentTitle = "Chinese Word";
        content = await generateChineseWord(history);
        break;
        
      default:
        logger.warn(`Unknown content type: ${sessionInfo.contentType}`);
        return;
    }
    
    if (content) {
      // Update history with new content
      if (history.length >= 10) {
        history.shift(); // Remove oldest item if we have 10+ items
      }
      history.push(content);
      
      // Cache the current content
      sessionInfo.currentContent = {
        type: contentTitle,
        content
      };
      
      // Send content to dashboard for all modes
      logger.info(`Sending ${contentTitle} to dashboard: ${content.substring(0, 30)}...`);
      
      // Main mode - just the content
      sessionInfo.session.dashboard.content.writeToMain(content);
      
      // Expanded mode - with title
      const expandedContent = `${contentTitle}: ${content}`;
      sessionInfo.session.dashboard.content.writeToExpanded(expandedContent);
      
      // Always-on mode - shortened version
      const alwaysOnContent = content.length > 35 
        ? content.substring(0, 35) + '...' 
        : content;
      sessionInfo.session.dashboard.content.writeToAlwaysOn(alwaysOnContent);
      
      // Update timestamp
      sessionInfo.lastUpdateTime = Date.now();
    }
  } catch (error) {
    logger.error(`Error generating content for session ${sessionId}:`, error);
  }
}

// Content generation helper functions
async function generateFunFact(history: string[]): Promise<string> {
  const funFactAgent = new FunFactAgent();
  const result = await funFactAgent.handleContext({ agentHistory: history });
  return result.insight;
}

async function generateQuote(history: string[]): Promise<string> {
  const quotesAgent = new FamousQuotesAgent();
  const result = await quotesAgent.handleContext({ agentHistory: history });
  return result.insight;
}

async function generateGratitude(history: string[]): Promise<string> {
  const gratitudeAgent = new GratitudePingAgent();
  const result = await gratitudeAgent.handleContext({ agentHistory: history });
  return result.insight;
}

async function generateNews(history: string[]): Promise<string> {
  const newsAgent = new NewsAgent();
  const result = await newsAgent.handleContext({ agentHistory: history });
  return result.insight;
}

async function generateTrashTalk(history: string[]): Promise<string> {
  const trashTalkAgent = new TrashTalkAgent();
  const result = await trashTalkAgent.handleContext({ agentHistory: history });
  return result.insight;
}

async function generateChineseWord(history: string[]): Promise<string> {
  const chineseWordAgent = new ChineseWordAgent();
  const result = await chineseWordAgent.handleContext({ agentHistory: history });
  return result.insight;
}

// ==================================
// Session Management
// ==================================
function cleanupSession(sessionId: string): void {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return;
  
  // Clear interval
  if (sessionInfo.updateInterval) {
    clearInterval(sessionInfo.updateInterval);
  }
  
  // Mark as inactive
  sessionInfo.isActive = false;
  
  // Disconnect session
  try {
    sessionInfo.session.disconnect();
  } catch (error) {
    logger.error(`Error disconnecting session ${sessionId}:`, error);
  }
  
  // Remove from active sessions
  activeSessions.delete(sessionId);
  logger.info(`Cleaned up session ${sessionId}`);
}

// ==================================
// Admin Endpoints
// ==================================

// Force generate new content
app.post('/admin/generate-content', async (req: express.Request, res: express.Response) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }
    
    if (!activeSessions.has(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    await generateAndSendContent(sessionId);
    res.status(200).json({ status: 'content generated' });
  } catch (error) {
    logger.error('Error generating content', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get active sessions
app.get('/admin/sessions', (req: express.Request, res: express.Response) => {
  const sessions = Array.from(activeSessions.keys()).map(sessionId => {
    const session = activeSessions.get(sessionId);
    return {
      sessionId,
      userId: session?.userId,
      contentType: session?.contentType,
      contentFrequency: session?.contentFrequency ? session.contentFrequency / (60 * 1000) : 0, // Convert to minutes
      lastUpdate: session?.lastUpdateTime ? new Date(session.lastUpdateTime).toISOString() : null
    };
  });
  
  res.status(200).json({ sessions, count: sessions.length });
});

// ==================================
// Health Check
// ==================================
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'healthy', 
    app: PACKAGE_NAME,
    sessions: activeSessions.size
  });
});

// ==================================
// Start Server
// ==================================
app.listen(PORT, () => {
  logger.info(`Dash TPA running on port ${PORT}`);
  logger.info(`Connecting to AugmentOS Cloud at ${CLOUD_HOST_NAME}`);
});