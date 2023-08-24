//
// Logger Module
//

/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
const winston = require('winston');
const LokiTransport = require('winston-loki');
const ms = require('ms');
const { cleanEnv, str, bool } = require('envalid');
require('dotenv').config();

let logger = {};

// Process ENV Parameters
const env = cleanEnv(process.env, {
  // Logging Options
  APP_NAME: str({ default: 'wi-room-release' }),
  LOKI_ENABLED: bool({ default: false }),
  LOKI_HOST: str({ default: 'http://loki:3100' }),
  CONSOLE_LEVEL: str({ default: 'info' }),
});

const appName = env.APP_NAME;
const lokiEnabled = env.LOKI_ENABLED;
const lokiHost = env.LOKI_HOST;
const consoleLevel = env.CONSOLE_LEVEL;

const LOG_TIME_DIFF = Symbol('LOG_TIME_DIFF');
// adds data to log event info object
const addTimeDiff = winston.format((info) => {
  const now = Date.now();
  if (!this._lastTimestamp) {
    this._lastTimestamp = now;
    info[LOG_TIME_DIFF] = 0;
  } else {
    const diff = now - this._lastTimestamp;
    this._lastTimestamp = now;
    info[LOG_TIME_DIFF] = diff;
  }

  return info;
});

// render it similar to `debug` library
const msgWithTimeDiff = winston.format((info) => {
  info.message = `${info.message} +${ms(info[LOG_TIME_DIFF])}`;
  return info;
});

function WinstonLogger(component) {
  const labels = {
    app: appName,
  };

  const transports = [
    // printing the logs to console
    new winston.transports.Console({
      format: winston.format.combine(
        addTimeDiff(),
        msgWithTimeDiff(),
        winston.format.errors({ stack: true }),
        winston.format.colorize({
          all: true,
        }),
        winston.format.label({
          label: `[${appName}:${component}]`,
        }),
        winston.format.printf((res) => {
          const time = new Date(Date.now());
          const year = time.getUTCFullYear();
          const month = time.getUTCMonth() + 1;
          const date = time.getUTCDate();
          const hour = time.getUTCHours();
          const min = time.getUTCMinutes();
          const sec = time.getUTCSeconds();

          const timeString = `${year}-${(`0${month}`).slice(-2)}-${(`0${date}`).slice(-2)} ${(`0${hour}`).slice(-2)}:${(`0${min}`).slice(-2)}:${(`0${sec}`).slice(-2)}Z`;
          return `${timeString} ${res.level} ${res.label} ${res.message}`;
        }),
      ),
      level: consoleLevel,
    }),
  ];

  if (lokiEnabled) {
    transports.push(
      // sending the logs to Loki which will be visualized by Grafana
      new LokiTransport({
        format: winston.format.combine(
          winston.format.errors({ stack: true }),
          winston.format.label({
            label: `[${appName}:${component}]`,
          }),
          winston.format.printf((res) => `${res.level} ${res.label} ${res.message}`),
        ),
        host: lokiHost,
        labels,
        level: 'debug',
      }),
    );
  }

  logger = winston.createLogger({
    transports,
  });

  // Streaming allows it to stream the logs back from the defined transports
  logger.stream = {
    write(message) {
      logger.info(`request: ${message}`);
    },
  };
  return logger;
}

module.exports = WinstonLogger;
