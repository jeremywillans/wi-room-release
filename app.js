//
// Room Release - Workspace Integration
//
// Copyright (c) 2023 Jeremy Willans
// Licensed under the MIT License
//
// App Entrypoint
//

/* eslint-disable no-param-reassign */
const wi = require('workspace-integrations');
const { bootstrap } = require('global-agent');
const schedule = require('node-schedule');
const { cleanEnv, str, bool } = require('envalid');
const logger = require('./src/logger')('app');
const utils = require('./src/utils');
const roomRelease = require('./src/roomRelease');
const httpService = require('./src/httpService');
const { name, version } = require('./package.json');

// Process ENV Parameters
const e = cleanEnv(process.env, {
  // Integration Options
  DEVICE_TAG: str({ default: name }),
  WI_LOGGING: str({ default: 'error' }),
  LOG_DETAILED: bool({ default: true }),
  CLIENT_ID: str(),
  CLIENT_SECRET: str(),
  // Integration Credentials
  CODE: str({ default: undefined }),
  OAUTH_URL: str({ default: undefined }),
  REFRESH_TOKEN: str({ default: undefined }),
  WEBEXAPIS_BASE_URL: str({ default: undefined }),
  APP_URL: str({ default: undefined }),
  // Global Agent Proxy
  GLOBAL_AGENT_HTTP_PROXY: str({ default: undefined }),
  GLOBAL_AGENT_NO_PROXY: str({ default: undefined }),
});

// Initialize Proxy Server, if defined.
if (e.GLOBAL_AGENT_HTTP_PROXY) {
  logger.info('invoke global agent proxy');
  bootstrap();
}

// Define WI Configuration from ENV Parameters
const wiConfig = {
  clientId: e.CLIENT_ID,
  clientSecret: e.CLIENT_SECRET,
  activationCode: {
    oauthUrl: e.OAUTH_URL,
    refreshToken: e.REFRESH_TOKEN,
    webexapisBaseUrl: e.WEBEXAPIS_BASE_URL,
    appUrl: e.APP_URL,
  },
  notifications: 'longpolling',
  logLevel: e.WI_LOGGING,
};

// Check and process new device
async function processDevice(i, d, deviceId, deviceObj) {
  let device = deviceObj;
  // Get Device object to obtain status and tag info
  if (!device) {
    try {
      device = await i.devices.getDevice(deviceId);
    } catch (error) {
      logger.warn(`Unable to get device: ${utils.shortName(deviceId)}`);
      logger.debug(deviceId);
      logger.debug(error.message);
      return;
    }
  }
  // Check device has correct tag
  if (!device.tags.includes(e.DEVICE_TAG)) return;
  // Ensure device is online before processing
  if (!device.connectionStatus.match(/^connected/)) return;
  // Ensure device meets version requirement
  if (!roomRelease.versionCheck(device.software)) {
    if (e.LOG_DETAILED) logger.warn(`Skipping Device ${utils.shortName(deviceId)} - Unsupported RoomOS`);
    return;
  }
  // Declare Class
  const id = utils.uniqueId(d, deviceId.replace('=', ''));
  d[deviceId] = new roomRelease.Init(i, id, deviceId, httpService);
  logger.info(`${d[deviceId].id}: ${utils.shortName(deviceId)}`);
  logger.info(`${d[deviceId].id}: Creating Instance for ${device.displayName}.`);
  try {
    // clear any lingering alerts
    d[deviceId].clearAlerts();
    // ensure codec is configured correctly
    await d[deviceId].configureCodec();
    d[deviceId].active = true;
    // check for current meeting
    const currentId = await i.xapi.status.get(deviceId, 'Bookings.Current.Id');
    if (currentId) {
      d[deviceId].processBooking(currentId);
    }
  } catch (error) {
    logger.warn(`${d[deviceId].id}: Unable to process Device!`);
    logger.debug(`${d[deviceId].id}: ${error.message}`);
  }
}

// Process devices based on tag
async function processDevices(i, d) {
  try {
    // Get devices from xapi
    const devices = await i.devices.getDevices({ tag: e.DEVICE_TAG });
    if (!devices.length) {
      logger.warn('No Matching Devices found!');
    }

    // Split into 20 Device Chunks to reduce load on API Servers during Startup
    const deviceGroups = devices.reduce((all, one, k) => {
      const ch = Math.floor(k / 20);
      // eslint-disable-next-line no-param-reassign
      all[ch] = [].concat((all[ch] || []), one);
      return all;
    }, []);

    // eslint-disable-next-line no-plusplus
    for (let k = 0; k < deviceGroups.length; k++) {
      const id = k + 1;
      if (deviceGroups.length > 1) logger.debug(`process group ${id} of ${deviceGroups.length}`);
      // Process tagged devices
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        deviceGroups[k].map(async (device) => {
          // skip if instance exists
          if (d[device.id]) return;
          await processDevice(i, d, device.id, device);
        }),
      );
    }

    // Remove untagged devices
    const toRemove = Object.keys(d).filter((j) => !devices.map((k) => k.id).includes(j));
    await Promise.all(
      toRemove.map(async (deviceId) => {
        logger.info(`${d[deviceId].id}: Device no longer tagged, removing Instance.`);
        d[deviceId] = null;
        delete d[deviceId];
      }),
    );

    logger.info(`Active Device Class Instances: ${Object.keys(d).filter((k) => d[k].active).length}`);
    const inactiveDevices = Object.keys(d).filter((k) => !d[k].active).length;
    if (inactiveDevices > 0) logger.warn(`Inactive Device Class Instances: ${inactiveDevices}`);
  } catch (error) {
    logger.warn('Unable to process devices');
    logger.debug(error.message);
  }
}

function deviceActive(sys) {
  if (!sys) return false;
  if (!sys.active) {
    logger.warn(`Notification detected from inactive device - ${sys.id}`);
    return false;
  }
  return true;
}

// Init integration
async function init(json) {
  logger.info(`Room Release Workspace Integration, v${version}`);
  let i;
  const d = {}; // Device Entities Object
  // Process integration credentials
  if (!e.OAUTH_URL) {
    try {
      wiConfig.activationCode = utils.parseJwt(e.CODE);
    } catch (error) {
      logger.error('Unable to decode token');
      logger.debug(error.message);
      process.exit(1);
    }
  }
  try {
    i = await wi.connect(json);
    i.onError(logger.error);
    i.onAction((action) => logger.info(`Integration action: ${JSON.stringify(action)}`));
    logger.info('Integration activation successful!');
  } catch (error) {
    logger.error('Not able to connect to Integration');
    logger.debug(error.message);
    process.exit(1);
  }

  try {
    // Process devices on startup
    logger.info('--- Processing Devices');
    await processDevices(i, d);

    // Periodically re-process devices to capture tag changes (every 30 mins)
    schedule.scheduleJob('*/30 * * * *', async () => {
      logger.info('--- Periodic Device Processing');
      await processDevices(i, d);
    });

    logger.info('--- Processing WI Subscriptions');
    // Process device ready
    i.xapi.status.on('SystemUnit.State.System', async (deviceId, _path, result) => {
      const sys = d[deviceId];
      if (!sys && result === 'Initialized') {
        await processDevice(i, d, deviceId);
      }
    });
    // Process reboot event
    i.xapi.event.on('BootEvent', (deviceId, _path, event) => {
      const sys = d[deviceId];
      if (sys) {
        logger.info(`${sys.id}: Device ${event.Action}, Removing Instance.`);
        d[deviceId] = null;
        delete d[deviceId];
      }
    });

    logger.info('--- Processing Subscriptions');
    // Process booking start
    i.xapi.event.on('Bookings.Start', (deviceId, _path, event) => {
      const sys = d[deviceId];
      if (!sys) {
        // attempt process device
        processDevice(i, d, deviceId);
        return;
      }
      if (!deviceActive(sys)) return;
      logger.info(`${sys.id}: Booking ${event.Id} detected`);
      sys.processBooking(event.Id);
    });
    // Process booking extension
    i.xapi.event.on('Bookings.ExtensionRequested', (deviceId, _path, event) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      logger.info(`${sys.id}: Booking ${event.OriginalMeetingId} updated`);
      sys.handleBookingExtension(event.OriginalMeetingId);
    });
    // Process booking end
    i.xapi.event.on('Bookings.End', (deviceId, _path, event) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      logger.info(`${sys.id}: Booking ${event.Id} ended Stop Checking`);
      sys.handleBookingEnd(event);
    });
    // Process UI interaction
    i.xapi.event.on('UserInterface.Extensions', (deviceId) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handleInteraction();
    });
    // Handle message prompt response
    i.xapi.event.on('UserInterface.Message.Prompt.Response', (deviceId, _path, event) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handlePromptResponse(event);
    });
    // Process active call
    i.xapi.status.on('SystemUnit.State.NumberOfActiveCalls', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handleActiveCall(status);
    });
    // Process MTR active call
    i.xapi.status.on('MicrosoftTeams.Calling.InCall', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handleMTRCall(status);
    });
    // Process presence detection
    i.xapi.status.on('RoomAnalytics.PeoplePresence', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handlePeoplePresence(status);
    });
    // Process presentation detection
    i.xapi.status.on('Conference.Presentation.LocalInstance', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handlePresentationLocalInstance(status);
    });
    // Process people count
    i.xapi.status.on('RoomAnalytics.PeopleCount.Current', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handlePeopleCount(status);
    });
    // Process sound level
    i.xapi.status.on('RoomAnalytics.Sound.Level.A', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handleSoundDetection(status);
    });
    // Process room in use
    i.xapi.status.on('RoomAnalytics.RoomInUse', (deviceId, _path, status) => {
      const sys = d[deviceId];
      if (!deviceActive(sys)) return;
      sys.handleRoomInUse(status);
    });
  } catch (error) {
    logger.error('Error during device and subscription processing');
    logger.debug(error.message);
  }
}

init(wiConfig);
