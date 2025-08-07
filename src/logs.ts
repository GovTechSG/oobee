/* eslint-disable no-console */
/* eslint-disable no-shadow */
import { createLogger, format, transports } from 'winston';
import { guiInfoStatusTypes } from './constants/constants.js';
import path from 'path';
import { randomUUID } from 'crypto';

const { combine, timestamp, printf } = format;

// Sample output
// {"timestamp":"2020-11-25 17:29:07","level":"error","message":"hello world"}
const logFormat = printf(({ timestamp, level, message }) => {
  const log = {
    timestamp: `${timestamp}`,
    level: `${level}`,
    message: `${message}`,
  };

  return JSON.stringify(log);
});

// transport: storage device for logs
// Enabled for console and storing into files; Files are overwritten each time
// All logs in combined.txt, error in errors.txt
const uuid = randomUUID();
let basePath: string;

if (process.env.OOBEE_LOGS_PATH) {
  basePath = process.env.OOBEE_LOGS_PATH;
} else if (process.platform === 'win32') {
  basePath = path.join(process.env.APPDATA, 'Oobee');
} else if (process.platform === 'darwin') {
  basePath = path.join(process.env.HOME, 'Library', 'Application Support', 'Oobee');
} else {
  basePath = path.join(process.cwd());
}

export const errorsTxtPath = path.join(basePath, `${uuid}.txt`);

const consoleLogger = createLogger({
  silent: !(process.env.RUNNING_FROM_PH_GUI || process.env.OOBEE_VERBOSE),
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    new transports.Console({ level: 'info' }),
    new transports.File({
      filename: errorsTxtPath,
      level: 'info',
      handleExceptions: true,
    }),
  ],
});

// No display in consoles, this will mostly be used within the interactive script to avoid disrupting the flow
// Also used in common functions to not link internal information
// if running from mass scanner, log out errors in console
const silentLogger = createLogger({
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    new transports.File({ 
      filename: errorsTxtPath,
      level: 'warn', 
      handleExceptions: true }),
  ].filter(Boolean),
});

// guiInfoLogger feeds the gui information via console log and is mainly used for scanning process
export const guiInfoLog = (status: string, data: { numScanned?: number; urlScanned?: string }) => {
  if (process.env.RUNNING_FROM_PH_GUI || process.env.OOBEE_VERBOSE) {
    switch (status) {
      case guiInfoStatusTypes.COMPLETED:
        console.log('Scan completed');
        silentLogger.info('Scan completed');
        break;
      case guiInfoStatusTypes.SCANNED:
      case guiInfoStatusTypes.SKIPPED:
      case guiInfoStatusTypes.ERROR:
      case guiInfoStatusTypes.DUPLICATE:
        const msg = `crawling::${data.numScanned || 0}::${status}::${
            data.urlScanned || 'no url provided'
          }`;
        console.log(msg);
        silentLogger.info(msg);
        break;
      default:
        console.log(`Status provided to gui info log not recognized: ${status}`);
        break;
    }
  }
};

consoleLogger.info(`Logger writing to: ${errorsTxtPath}`);

export { logFormat, consoleLogger, silentLogger };
