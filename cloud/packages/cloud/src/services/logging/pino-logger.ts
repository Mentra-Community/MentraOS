import pino from "pino";
// import { posthog } from "./posthog.service";
// import { pinoPostHogTransport } from "./transports/PostHogTransport";

// Constants and configuration
const DEPLOYMENT_REGION = process.env.DEPLOYMENT_REGION;
const isChina = DEPLOYMENT_REGION === "china";

const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN;
const BETTERSTACK_ENDPOINT = process.env.BETTERSTACK_ENDPOINT || "https://s1311181.eu-nbg-2.betterstackdata.com";
const NODE_ENV = process.env.NODE_ENV || "development";
const REGION = process.env.REGION || process.env.DEPLOYMENT_REGION || "";
const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local";

// Log filtering configuration
const LOG_FEATURES = process.env.LOG_FEATURES?.split(",").map((f) => f.trim()) || [];
const LOG_EXCLUDE_FEATURES = process.env.LOG_EXCLUDE_FEATURES?.split(",").map((f) => f.trim()) || [];
const LOG_SERVICES = process.env.LOG_SERVICES?.split(",").map((s) => s.trim()) || [];
const LOG_EXCLUDE_SERVICES = process.env.LOG_EXCLUDE_SERVICES?.split(",").map((s) => s.trim()) || [];

// Determine log level based on environment
// Use 'info' in development to reduce noise from debug logs
const LOG_LEVEL = NODE_ENV === "production" ? "info" : "debug";

// Custom filtering function
const shouldLogMessage = (logObj: any): boolean => {
  // If no filters are set, log everything
  if (
    LOG_FEATURES.length === 0 &&
    LOG_EXCLUDE_FEATURES.length === 0 &&
    LOG_SERVICES.length === 0 &&
    LOG_EXCLUDE_SERVICES.length === 0
  ) {
    return true;
  }

  const feature = logObj.feature;
  const service = logObj.service;

  // Check feature filters
  if (LOG_FEATURES.length > 0 && (!feature || !LOG_FEATURES.includes(feature))) {
    return false;
  }

  if (LOG_EXCLUDE_FEATURES.length > 0 && feature && LOG_EXCLUDE_FEATURES.includes(feature)) {
    return false;
  }

  // Check service filters
  if (LOG_SERVICES.length > 0 && (!service || !LOG_SERVICES.includes(service))) {
    return false;
  }

  if (LOG_EXCLUDE_SERVICES.length > 0 && service && LOG_EXCLUDE_SERVICES.includes(service)) {
    return false;
  }

  return true;
};

// Setup streams array for Pino multistream
const streams: pino.StreamEntry[] = [];

// Custom filtering stream wrapper
const createFilteredStream = (targetStream: any, _level: string) => ({
  write: (line: string) => {
    try {
      const logObj = JSON.parse(line);
      if (shouldLogMessage(logObj)) {
        targetStream.write(line);
      }
    } catch {
      // If we can't parse the JSON, pass it through
      targetStream.write(line);
    }
  },
});

// Pretty transport for development with filtering
const prettyTransport = pino.transport({
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "SYS:standard",
    ignore: "pid,hostname,env,service,server,req,res,responseTime",
    messageFormat: "{msg}",
    errorProps: "*",
  },
});

// Apply filtering to pretty transport
const filteredPrettyStream = createFilteredStream(prettyTransport, LOG_LEVEL);

streams.push({
  stream: filteredPrettyStream,
  level: LOG_LEVEL,
});

// Add BetterStack transport if token is provided (with filtering)
if (BETTERSTACK_SOURCE_TOKEN && !isChina) {
  const betterStackTransport = pino.transport({
    target: "@logtail/pino",
    options: {
      sourceToken: BETTERSTACK_SOURCE_TOKEN,
      options: { endpoint: BETTERSTACK_ENDPOINT },
    },
  });

  const filteredBetterStackStream = createFilteredStream(betterStackTransport, LOG_LEVEL);

  streams.push({
    stream: filteredBetterStackStream,
    level: LOG_LEVEL,
  });
} else if (isChina) {
  console.log("BetterStack is disabled for China");
}

// Create multistream
const multistream = pino.multistream(streams);

/**
 * Configuration for the root logger
 */
const baseLoggerOptions: pino.LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    env: NODE_ENV,
    server: PORTER_APP_NAME,
    region: REGION,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Create the root logger with multiple streams
export const logger = pino(baseLoggerOptions, multistream);

// Log the current filter configuration on startup
if (
  LOG_FEATURES.length > 0 ||
  LOG_EXCLUDE_FEATURES.length > 0 ||
  LOG_SERVICES.length > 0 ||
  LOG_EXCLUDE_SERVICES.length > 0
) {
  logger.info(
    {
      LOG_FEATURES: LOG_FEATURES.length > 0 ? LOG_FEATURES : undefined,
      LOG_EXCLUDE_FEATURES: LOG_EXCLUDE_FEATURES.length > 0 ? LOG_EXCLUDE_FEATURES : undefined,
      LOG_SERVICES: LOG_SERVICES.length > 0 ? LOG_SERVICES : undefined,
      LOG_EXCLUDE_SERVICES: LOG_EXCLUDE_SERVICES.length > 0 ? LOG_EXCLUDE_SERVICES : undefined,
    },
    "Log filtering enabled",
  );
}

// Flush logger on process exit
// let isExiting = false;

// const gracefulShutdown = async (signal: string) => {
//   if (isExiting) return;
//   isExiting = true;

//   logger.warn(`Received ${signal}, shutting down gracefully...`);

//   // Quick flush and exit
//   try {
//     logger.flush();
//   } catch {
//     // Ignore flush errors
//   }

//   process.exit(0);
// };

// Default export is the logger
export default logger;
