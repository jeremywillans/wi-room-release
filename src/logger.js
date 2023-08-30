//
// Logger Module
//

/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */
const winston = require('winston');
const LokiTransport = require('winston-loki');
const { Syslog } = require('winston-syslog');
const ms = require('ms');
// eslint-disable-next-line object-curly-newline
const { cleanEnv, str, bool, num } = require('envalid');
require('dotenv').config();

let logger = {};

// Process ENV Parameters
const env = cleanEnv(process.env, {
  // Logging Options
  APP_NAME: str({ default: 'wi-teams-button' }),
  SYSLOG_ENABLED: bool({ default: false }),
  SYSLOG_HOST: str({ default: 'syslog' }),
  SYSLOG_PORT: num({ default: 514 }),
  SYSLOG_PROTOCOL: str({ default: 'udp4' }),
  SYSLOG_SOURCE: str({ default: 'localhost' }),
  LOKI_ENABLED: bool({ default: false }),
  LOKI_HOST: str({ default: 'http://loki:3100' }),
  CONSOLE_LEVEL: str({ default: 'info' }),
});

const appName = env.APP_NAME;

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

  let destinations = 'Console';
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
      level: env.CONSOLE_LEVEL,
    }),
  ];

  if (env.SYSLOG_ENABLED) {
    destinations += ', Syslog';
    transports.push(
      // sending the logs to external syslog server
      new Syslog({
        format: winston.format.combine(
          winston.format.errors({ stack: true }),
          winston.format.label({
            label: `[${appName}:${component}]`,
          }),
          winston.format.printf((res) => `${res.level} ${res.label} ${res.message}`),
        ),
        host: env.SYSLOG_HOST,
        port: env.SYSLOG_PORT,
        protocol: env.SYSLOG_PROTOCOL,
        localhost: env.SYSLOG_SOURCE,
        app_name: appName,
        level: 'debug',
      }),
    );
  }

  if (env.LOKI_ENABLED) {
    destinations += ', Loki';
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
        host: env.LOKI_HOST,
        labels,
        level: 'debug',
      }),
    );
  }

  logger = winston.createLogger({
    transports,
  });

  if (component === 'app') {
    setTimeout(() => {
      // added minor delay to show app log entry first
      logger.info(`Logging destinations enabled: ${destinations}`);
    }, 100);
  }

  // Streaming allows it to stream the logs back from the defined transports
  logger.stream = {
    write(message) {
      logger.info(`request: ${message}`);
    },
  };
  return logger;
}

module.exports = WinstonLogger;
