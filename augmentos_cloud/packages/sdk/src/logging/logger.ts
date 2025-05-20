import pino from 'pino';

const prettyTransport = pino.transport({
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
    levelFirst: true,
  }
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'debug',
    name: process.env.SERVICE_NAME,
  },
  prettyTransport
);