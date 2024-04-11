//
// File Service Module
//

const { cleanEnv, bool, str } = require('envalid');
const fs = require('fs/promises');
const logger = require('./logger')(__filename.slice(__dirname.length + 1, -3));

// Process ENV Parameters
const e = cleanEnv(process.env, {
  LOG_DETAILED: bool({ default: true }),
  APP_PLATFORM: str({ default: 'local' }),
  // Graph API JSON
  GRAPH_JSON: str({ default: 'config/graph.json' }),
});

let filePath;
if (e.APP_PLATFORM === 'container') {
  filePath = `${__dirname}/../../${e.GRAPH_JSON}`;
} else {
  filePath = `${__dirname}/../${e.GRAPH_JSON}`;
}

let memStore;
let validStore = false;

// Sleep Function
async function sleep(ms) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStore(deviceId) {
  if (!validStore) return false;
  if (!memStore[deviceId]) {
    return {};
  }
  return memStore[deviceId];
}
exports.getStore = getStore;

async function updateStore(deviceId, deviceJson) {
  if (!validStore) return;
  memStore[deviceId] = deviceJson;
  const data = { devices: memStore };
  try {
    await fs.writeFile(filePath, JSON.stringify(data));
    logger.debug('Graph store updated');
  } catch (error) {
    logger.error('Unable to update graph store');
    logger.debug(error.message);
  }
}
exports.updateStore = updateStore;

async function init() {
  try {
    try {
      await fs.access(filePath, fs.constants.F_OK);
    } catch (err) {
      try {
        logger.warn('Graph Store does not exist.. attempting to create');
        logger.warn(`Location: ${filePath}`);
        const initStore = { devices: {} };
        await fs.writeFile(filePath, JSON.stringify(initStore));
      } catch (error) {
        logger.error('Unable to create graph store...');
        logger.debug(error.message);
        logger.error('--- DELAY 10 SEC ---');
        await sleep(10000);
        throw new Error('NO_GRAPH');
      }
    }
    memStore = JSON.parse(await fs.readFile(filePath)).devices;
    if (!memStore) throw new Error('PARSE_ERROR');
    validStore = true;
    logger.info('Graph store loaded successfully');
  } catch (error) {
    logger.error('Unable to load Graph store');
    logger.debug(error.message);
  }
}
exports.init = init;
