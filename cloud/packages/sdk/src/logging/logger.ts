import pino from "pino"

// Constants and configuration
const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN
const BETTERSTACK_ENDPOINT = process.env.BETTERSTACK_ENDPOINT || "https://s1311181.eu-nbg-2.betterstackdata.com"
const NODE_ENV = process.env.NODE_ENV || "development"
const PORTER_APP_NAME = process.env.PORTER_APP_NAME || "cloud-local"

// Determine log level based on environment
const LOG_LEVEL = NODE_ENV === "production" ? "info" : "debug"

// Setup streams array for Pino multistream
const streams: pino.StreamEntry[] = []

// Use pretty print in development for better readability
// if (PRETTY_PRINT && NODE_ENV !== 'production') {
// Pretty transport for development
const prettyTransport = pino.transport({
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "SYS:standard",
    ignore: "pid,hostname,env,module,server",
    messageFormat: "{msg}",
    errorProps: "*",
    customPrettifiers: {
      // Add custom prettifiers here if needed
    },
  },
})

streams.push({
  stream: prettyTransport,
  level: LOG_LEVEL,
})
// } else {
//   // Plain console in production (JSON format)
//   streams.push({
//     stream: process.stdout,
//     level: LOG_LEVEL,
//   });
// }

// Add BetterStack transport if token is provided
if (BETTERSTACK_SOURCE_TOKEN) {
  try {
    const betterStackTransport = pino.transport({
      target: "@logtail/pino",
      options: {
        sourceToken: BETTERSTACK_SOURCE_TOKEN,
        options: {endpoint: BETTERSTACK_ENDPOINT},
      },
    })

    streams.push({
      stream: betterStackTransport,
      level: LOG_LEVEL,
    })
  } catch (error) {
    console.warn("BetterStack logging unavailable:", error instanceof Error ? error.message : error)
  }
}

// Create multistream
const multistream = pino.multistream(streams)

/**
 * Configuration for the root logger
 */
const baseLoggerOptions: pino.LoggerOptions = {
  level: LOG_LEVEL,
  base: {
    env: NODE_ENV,
    server: PORTER_APP_NAME,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
}

// Create the root logger with multiple streams
export const logger = pino(baseLoggerOptions, multistream)

// Flush logger on process exit
// process.on('beforeExit', async () => {
//   logger.flush(); // Flush the root logger
//   console.log('Logger flushed before exit');
// });

// Default export is the logger
export default logger
