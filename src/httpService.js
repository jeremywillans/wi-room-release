const Axios = require('axios');
const axiosRetry = require('axios-retry');
const rateLimit = require('axios-rate-limit');
const { cleanEnv, bool, num } = require('envalid');
const logger = require('./logger')('httpService');

// Process ENV Parameters
const env = cleanEnv(process.env, {
  LOG_DETAILED: bool({ default: true }),
  RR_HTTP_TIMEOUT: num({ default: 60000 }), // Milliseconds
});

const axios = rateLimit(
  Axios.create({ timeout: env.RR_HTTP_TIMEOUT }),
  { maxRPS: 5 },
);

axiosRetry(axios, {
  retries: 5,
  retryDelay: (retryCount, error) => {
    if (error.response) {
      const retryTimeout = error.response.headers['retry-after'];
      if (retryTimeout) {
        logger.debug(`retry-after time: ${retryTimeout}`);
        // Add Small Buffer
        return retryTimeout * 1200;
      }
    }
    if (error.message === 'ECONNABORTED') {
      return 15000;
    }
    if (error.code) {
      if (error.code === 'ECONNABORTED') {
        logger.debug('ECONNABORTED, try after 5sec');
        return 5000;
      }
    }
    return axiosRetry.exponentialDelay(retryCount, error);
  },
  retryCondition: (e) => {
    const retry = axiosRetry.isNetworkOrIdempotentRequestError(e) || e.code === 'ECONNABORTED';
    if (e.response) {
      logger.debug(`Axios Retry Invoked. ${e.response.status}`);
      // if (e.response.status === 404) { return false; }
      if (e.response.status === 429 || retry) {
        return true;
      }
    } else if (retry) {
      logger.debug('Axios Retry Invoked.');
      return true;
    }
    return false;
  },
});

function postMessage(accessToken, destId, message, format, direct, replyId) {
  return new Promise((resolve, reject) => {
    const directMessage = direct || false;
    const messageFormat = format || 'markdown';
    const options = {
      method: 'POST',
      url: 'https://webexapis.com/v1/messages',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: {},
      json: true,
    };
    if (directMessage) {
      options.data.toPersonId = destId;
    } else {
      options.data.roomId = destId;
    }
    if (replyId) {
      options.data.parentId = replyId;
    }
    options.data[messageFormat] = message;
    if (messageFormat === 'markdown') {
      options.data[messageFormat] = message.replace(/\\n/g, '\n');
    }

    axios
      .request(options)
      .then((response) => {
        // Check JSON payload is compliant with specs
        if (!response.data) {
          logger.debug('could not parse message details: bad or invalid json payload.');
          reject(response.status);
        }
        logger.debug('message sent');
        resolve();
      })
      .catch((error) => {
        logger.debug(`postMessage error: ${error.message}`);
        if (error.response && error.response.headers.trackingid) {
          logger.debug(`tid: ${error.response.headers.trackingid}`);
        }
        reject(error);
      });
  });
}
exports.postMessage = postMessage;
