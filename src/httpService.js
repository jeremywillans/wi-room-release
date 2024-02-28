//
// HTTP Service Module
//

const Axios = require('axios');
const axiosRetry = require('axios-retry');
const rateLimit = require('axios-rate-limit');
const { cleanEnv, bool, num } = require('envalid');
const logger = require('./logger')(__filename.slice(__dirname.length + 1, -3));

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

function postHttp(id, headerArray, url, data) {
  return new Promise((resolve, reject) => {
    const headers = headerArray.reduce((acc, cur) => {
      const a = cur.split(': ');
      [, acc[a[0]]] = a;
      return acc;
    }, {});
    const options = {
      method: 'POST',
      url,
      headers,
      data,
      json: true,
    };

    axios
      .request(options)
      .then((response) => {
        // RoomOS HTTP Client Interop
        response.StatusCode = response.status;
        if (response.status === 204) {
          logger.debug('postHttp noContent');
          resolve(response);
          return;
        }
        // Parse Response
        if (!response.data) {
          logger.debug(`${id}: 'could not parse data: bad or invalid json payload.`);
          reject(response);
        }
        resolve(response);
      })
      .catch((error) => {
        logger.debug(`${id}: postHttp error: ${error.message}`);
        if (error.response && error.response.headers.trackingid) {
          logger.debug(`${id}: tid: ${error.response.headers.trackingid}`);
        }
        reject(error);
      });
  });
}
exports.postHttp = postHttp;

function getHttp(id, headerArray, url) {
  const headers = headerArray.reduce((acc, cur) => {
    const a = cur.split(': ');
    [, acc[a[0]]] = a;
    return acc;
  }, {});
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      url,
      headers,
      json: true,
    };

    axios
      .request(options)
      .then((response) => {
        // RoomOS HTTP Client Interop
        response.StatusCode = response.status;
        if (response.status === 204) {
          logger.debug('getHttp noContent');
          resolve(response);
          return;
        }
        // Parse Response
        if (!response.data) {
          logger.debug(`${id}: 'could not parse data: bad or invalid json payload.`);
          reject(response);
        }
        resolve(response);
      })
      .catch((error) => {
        logger.debug(`${id}: getHttp error: ${error.message}`);
        if (error.response && error.response.headers.trackingid) {
          logger.debug(`${id}: tid: ${error.response.headers.trackingid}`);
        }
        reject(error);
      });
  });
}
exports.getHttp = getHttp;
