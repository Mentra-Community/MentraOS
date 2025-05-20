import { createServer } from 'http';
import { parse } from 'url';

interface DebugSessionInfo {
  sessionId: string;
  userId: string;
  startTime: string;
  disconnectedAt: string | null;
  activeAppSessions: string[];
  installedApps: Array<{ packageName: string; name: string }>;
  loadingApps: Set<string>;
  isTranscribing: boolean;
  transcript: {
    segments: Array<{
      resultId: string;
      text: string;
      timestamp: Date;
      isFinal: boolean;
    }>;
    languageSegments: Record<string, Array<{
      resultId: string;
      text: string;
      timestamp: Date;
      isFinal: boolean;
    }>>;
  };
  subscriptionManager: {
    subscriptions: Record<string, string[]>;
  };
  displayManager: {
    activeDisplay: {
      displayRequest: {
        packageName: string;
        layout: {
          layoutType: string;
          text?: string;
          title?: string;
        };
        timestamp: Date;
      };
      startedAt: Date;
    } | null;
    displayHistory: Array<{
      displayRequest: {
        packageName: string;
        layout: {
          layoutType: string;
          text?: string;
          title?: string;
        };
        timestamp: Date;
      };
      startedAt: Date;
    }>;
  };
  dashboardManager: {
    dashboardMode: string;
    alwaysOnEnabled: boolean;
    contentQueue: string[];
  };
  appConnections: Record<string, { readyState: number }>;
  lastAudioTimestamp: number;
  transcriptionStreams: Record<string, { status: string; language: string }>;
  audioBuffer: {
    chunks: any[];
    lastProcessedSequence: number;
    processingInProgress: boolean;
  };
  lc3Service: {
    initialized: boolean;
    status: string;
  } | null;
  recentEvents: Array<{
    time: string;
    description: string;
  }>;
}

interface SystemStats {
  activeSessions: number;
  totalSessions: number;
  activeTpas: number;
  totalTpas: number;
}

interface ApiResponse {
  sessions: DebugSessionInfo[];
  stats: SystemStats;
}

// Mock data
const mockSessions: DebugSessionInfo[] = [
  {
    sessionId: 'session-1',
    userId: 'user-1',
    startTime: new Date(Date.now() - 3600000).toISOString(),
    disconnectedAt: null,
    activeAppSessions: ['tpa-1', 'tpa-2'],
    installedApps: [
      { packageName: 'tpa-1', name: 'TPA 1' },
      { packageName: 'tpa-2', name: 'TPA 2' }
    ],
    loadingApps: new Set(['tpa-3']),
    isTranscribing: true,
    transcript: {
      segments: [
        {
          resultId: 'seg-1',
          text: 'Hello, how can I help you?',
          timestamp: new Date(Date.now() - 5000),
          isFinal: true
        }
      ],
      languageSegments: {
        'en-US': [
          {
            resultId: 'seg-1',
            text: 'Hello, how can I help you?',
            timestamp: new Date(Date.now() - 5000),
            isFinal: true
          }
        ]
      }
    },
    subscriptionManager: {
      subscriptions: {
        'tpa-1': ['display', 'audio'],
        'tpa-2': ['display']
      }
    },
    displayManager: {
      activeDisplay: {
        displayRequest: {
          packageName: 'tpa-1',
          layout: {
            layoutType: 'text_wall',
            text: 'Welcome to TPA 1'
          },
          timestamp: new Date(Date.now() - 10000)
        },
        startedAt: new Date(Date.now() - 10000)
      },
      displayHistory: [
        {
          displayRequest: {
            packageName: 'tpa-2',
            layout: {
              layoutType: 'reference_card',
              title: 'Reference',
              text: 'This is a reference card'
            },
            timestamp: new Date(Date.now() - 20000)
          },
          startedAt: new Date(Date.now() - 20000)
        }
      ]
    },
    dashboardManager: {
      dashboardMode: 'active',
      alwaysOnEnabled: true,
      contentQueue: ['tpa-1', 'tpa-2']
    },
    appConnections: {
      'tpa-1': { readyState: 1 },
      'tpa-2': { readyState: 1 }
    },
    lastAudioTimestamp: Date.now() - 1000,
    transcriptionStreams: {
      'en-US': { status: 'active', language: 'en-US' }
    },
    audioBuffer: {
      chunks: [],
      lastProcessedSequence: 100,
      processingInProgress: false
    },
    lc3Service: {
      initialized: true,
      status: 'ready'
    },
    recentEvents: [
      {
        time: new Date(Date.now() - 5000).toISOString(),
        description: 'TPA 1 started'
      },
      {
        time: new Date(Date.now() - 10000).toISOString(),
        description: 'TPA 2 started'
      }
    ]
  },
  {
    sessionId: 'session-2',
    userId: 'user-2',
    startTime: new Date(Date.now() - 7200000).toISOString(),
    disconnectedAt: new Date(Date.now() - 3600000).toISOString(),
    activeAppSessions: [],
    installedApps: [
      { packageName: 'tpa-1', name: 'TPA 1' }
    ],
    loadingApps: new Set(),
    isTranscribing: false,
    transcript: {
      segments: [],
      languageSegments: {}
    },
    subscriptionManager: {
      subscriptions: {}
    },
    displayManager: {
      activeDisplay: null,
      displayHistory: []
    },
    dashboardManager: {
      dashboardMode: 'inactive',
      alwaysOnEnabled: false,
      contentQueue: []
    },
    appConnections: {},
    lastAudioTimestamp: 0,
    transcriptionStreams: {},
    audioBuffer: {
      chunks: [],
      lastProcessedSequence: 0,
      processingInProgress: false
    },
    lc3Service: null,
    recentEvents: [
      {
        time: new Date(Date.now() - 3600000).toISOString(),
        description: 'Session disconnected'
      }
    ]
  }
];

const mockStats: SystemStats = {
  activeSessions: 1,
  totalSessions: 2,
  activeTpas: 2,
  totalTpas: 3
};

// Create mock server
const server = createServer((req, res) => {
  const { pathname } = parse(req.url || '', true);

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Handle API routes
  if (pathname === '/api/debug/sessions') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      sessions: mockSessions,
      stats: mockStats
    }));
    return;
  }

  // Handle 404
  res.writeHead(404);
  res.end('Not found');
});

// Start server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Mock server running at http://localhost:${PORT}`);
}); 