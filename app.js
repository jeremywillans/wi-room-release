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
const { RoomRelease } = require('./src/roomRelease');

// Process ENV Parameters
const e = cleanEnv(process.env, {
  // Integration Options
  DEVICE_TAG: str({ default: 'wi-room-release' }),
  WI_LOGGING: str({ default: 'error' }),
  DEBUG_MODE: bool({ default: true }),
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
      if (e.DEBUG_MODE) logger.debug(error.message);
      return;
    }
  }
  // Check device has correct tag
  if (!device.tags.includes(e.DEVICE_TAG)) return;
  // Ensure device is online before processing
  if (!device.connectionStatus.match(/^connected/)) return;
  // Declare Class
  const id = utils.uniqueId(d, deviceId.replace('=', ''));
  d[deviceId] = new RoomRelease(i, id, deviceId);
  logger.info(`${d[deviceId].id}: ${utils.shortName(deviceId)}`);
  logger.info(`${d[deviceId].id}: Creating Instance for ${device.displayName}.`);
  try {
    // clear any lingering alerts
    d[deviceId].clearAlerts();
    // ensure codec is configured correctly
    await d[deviceId].configureCodec();
    // check for current meeting
    const currentId = await i.xapi.status.get(deviceId, 'Bookings.Current.Id');
    if (currentId) {
      d[deviceId].processBooking(currentId);
    }
  } catch (error) {
    logger.warn(`${d[deviceId].id}: Unable to process Device!`);
    if (e.DEBUG_MODE) logger.debug(error.message);
  }
}

// Process devices based on tag
async function processDevices(i, d) {
  try {
    // Get devices from xapi
    const devices = await i.devices.getDevices({ tag: e.DEVICE_TAG });
    if (!devices.length) {
      logger.error('No Matching Devices found!');
      return;
    }

    // Process tagged devices
    await Promise.all(
      devices.map(async (device) => {
        // skip if instance exists
        if (d[device.id]) return;
        await processDevice(i, d, device.id, device);
      }),
    );

    // Remove untagged devices
    const toRemove = Object.keys(d).filter((j) => !devices.map((k) => k.id).includes(j));
    toRemove.forEach((item) => {
      logger.info(`${d[item].id}: Device no longer tagged, Removing Instance.`);
      d[item] = null;
      delete d[item];
    });
  } catch (error) {
    logger.warn('Unable to process devices');
    if (e.DEBUG_MODE) logger.debug(error.message);
  }
}

// Init integration
async function init(json) {
  let i;
  const d = {}; // Device Entities Object
  // Process integration credentials
  if (!e.OAUTH_URL) {
    try {
      wiConfig.activationCode = utils.parseJwt(e.CODE);
    } catch (error) {
      logger.error('Unable to decode token');
      if (e.DEBUG_MODE) logger.debug(error.message);
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
    if (e.DEBUG_MODE) logger.debug(error.message);
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
    // Process Device Ready
    i.xapi.status.on('SystemUnit.State.System', async (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr && result === 'Initialized') {
        await processDevice(i, d, deviceId);
      }
    });
    // Process Reboot Event
    i.xapi.event.on('BootEvent', (deviceId, _path, event) => {
      const rr = d[deviceId];
      if (rr) {
        logger.info(`${rr.id}: Device ${event.Action}, Removing Instance.`);
        d[deviceId] = null;
        delete d[deviceId];
      }
    });

    logger.info('--- Processing Room Resource Subscriptions');
    // Process booking start
    i.xapi.event.on('Bookings.Start', (deviceId, _path, event) => {
      const rr = d[deviceId];
      if (!rr) {
        // attempt process device
        processDevice(i, d, deviceId);
        return;
      }
      logger.info(`${rr.id}: Booking ${event.Id} detected`);
      rr.processBooking(event.Id);
    });
    // Process booking extension
    i.xapi.event.on('Bookings.ExtensionRequested', (deviceId, _path, event) => {
      const rr = d[deviceId];
      if (!rr) return;
      logger.info(`${rr.id}: Booking ${event.OriginalMeetingId} updated`);
      rr.handleBookingExtension(event.OriginalMeetingId);
    });
    // Process booking end
    i.xapi.event.on('Bookings.End', (deviceId, _path, event) => {
      const rr = d[deviceId];
      if (!rr) return;
      logger.info(`${rr.id}: Booking ${event.Id} ended Stop Checking`);
      rr.handleBookingEnd(event);
    });
    // Process UI interaction
    i.xapi.event.on('UserInterface.Extensions', (deviceId) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handleInteraction();
    });
    // Handle message prompt response
    i.xapi.event.on('UserInterface.Message.Prompt.Response', (deviceId, _path, event) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handlePromptResponse(event);
    });
    // Process active call
    i.xapi.status.on('SystemUnit.State.NumberOfActiveCalls', (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handleActiveCall(result);
    });
    // Process presence detection
    i.xapi.status.on('RoomAnalytics.PeoplePresence', (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handlePeoplePresence(result);
    });
    // Process ultrasound detection
    i.xapi.status.on('RoomAnalytics.UltrasoundPresence', (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handleUltrasoundPresence(result);
    });
    // Process presentation detection
    i.xapi.status.on('Conference.Presentation.LocalInstance', (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handlePresentationLocalInstance(result);
    });
    // Process people count
    i.xapi.status.on('RoomAnalytics.PeopleCount.Current', (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handlePeopleCount(result);
    });
    // Process sound level
    i.xapi.status.on('RoomAnalytics.Sound.Level.A', (deviceId, _path, result) => {
      const rr = d[deviceId];
      if (!rr) return;
      rr.handleSoundDetection(result);
    });
  } catch (error) {
    logger.warn('Error during device and subscription processing');
    if (e.DEBUG_MODE) logger.debug(error.message);
  }
}

init(wiConfig);
