//
// RoomRelease Module
//

// eslint-disable-next-line object-curly-newline
const { cleanEnv, str, bool, num } = require('envalid');
const logger = require('./logger')(__filename.slice(__dirname.length + 1, -3));

// Process ENV Parameters
const e = cleanEnv(process.env, {
  LOG_DETAILED: bool({ default: true }),
  // Occupancy Detections
  RR_ROOM_IN_USE: bool({ default: true }),
  // Legacy Occupancy Detections
  RR_USE_SOUND: bool({ default: false }),
  RR_USE_ACTIVE_CALL: bool({ default: true }),
  RR_USE_INTERACTION: bool({ default: true }),
  RR_USE_PRESENTATION: bool({ default: true }),
  RR_SOUND_LEVEL: num({ default: 50 }), // dBA
  // Disable Occupancy Checks
  RR_BUTTON_STOP_CHECKS: bool({ default: false }),
  RR_OCCUPIED_STOP_CHECKS: bool({ default: false }),
  RR_CONSIDERED_OCCUPIED: num({ default: 15 }), // Minutes
  // Thresholds and Timers
  RR_EMPTY_BEFORE_RELEASE: num({ default: 5 }), // Minutes
  RR_INITIAL_RELEASE_DELAY: num({ default: 10 }), // Minutes
  RR_IGNORE_LONGER_THAN: num({ default: 3 }), // Hours
  RR_PROMPT_DURATION: num({ default: 60 }), // Seconds
  RR_PERIODIC_INTERVAL: num({ default: 1 }), // Minutes
  // Webex Notification Options
  RR_WEBEX_ENABLED: bool({ default: false }),
  RR_WEBEX_ROOM_ID: str({ default: undefined }),
  RR_WEBEX_BOT_TOKEN: str({ default: undefined }),
  // MS Teams Notification Options
  RR_TEAMS_ENABLED: bool({ default: false }),
  RR_TEAMS_WEBHOOK: str({ default: undefined }),
  // Other Parameters
  RR_TEST_MODE: bool({ default: false }),
  RR_PlAY_ANNOUNCEMENT: bool({ default: true }),
  RR_FEEDBACK_ID: str({ default: 'alertResponse' }),
});

// RoomOS Version Check
const minVersion = '11.0.0.0';
function versionCheck(sysVersion) {
  const reg = /^\D*(?<MAJOR>\d*)\.(?<MINOR>\d*)\.(?<EXTRA>\d*)\.(?<BUILD>\d*).*$/i;
  const x = (reg.exec(sysVersion)).groups;
  const y = (reg.exec(minVersion)).groups;
  if (Number(x.MAJOR) > Number(y.MAJOR)) return true;
  if (Number(x.MAJOR) < Number(y.MAJOR)) return false;
  if (Number(x.MINOR) > Number(y.MINOR)) return true;
  if (Number(x.MINOR) < Number(y.MINOR)) return false;
  if (Number(x.EXTRA) > Number(y.EXTRA)) return true;
  if (Number(x.EXTRA) < Number(y.EXTRA)) return false;
  if (Number(x.BUILD) > Number(y.BUILD)) return true;
  if (Number(x.BUILD) < Number(y.BUILD)) return false;
  return false;
}
exports.versionCheck = versionCheck;

// Define Room Release options from ENV Parameters
const rrOptions = {
  // Occupancy Detections
  roomInUse: e.RR_ROOM_IN_USE, // leverage new consolidated metric to determine occupancy status

  // Legacy Occupancy Detections
  detectSound: e.RR_USE_SOUND, // Use sound level to consider room occupied (set level below)
  detectActiveCalls: e.RR_USE_ACTIVE_CALL, // Use active call for detection (inc airplay)
  detectInteraction: e.RR_USE_INTERACTION, // UI extensions (panel, button, etc) to detect presence.
  detectPresentation: e.RR_USE_PRESENTATION, // Use presentation sharing for detection
  soundLevel: e.RR_SOUND_LEVEL, // (dB) Minimum sound level required to consider occupied

  // Disable Occupancy Checks
  // *NOTE* If these are both false, occupancy checks will continue for duration of meeting
  buttonStopChecks: e.RR_BUTTON_STOP_CHECKS, // Stop further occupancy checks after check in
  occupiedStopChecks: e.RR_OCCUPIED_STOP_CHECKS, // Stop periodic checks if room considered occupied
  consideredOccupied: e.RR_CONSIDERED_OCCUPIED, // (Mins) minimum duration until considered occupied

  // Thresholds and Timers
  emptyBeforeRelease: e.RR_EMPTY_BEFORE_RELEASE, // (Mins) time empty until prompt for release
  initialReleaseDelay: e.RR_EMPTY_BEFORE_RELEASE, // (Mins) initial delay before prompt for release
  ignoreLongerThan: e.RR_IGNORE_LONGER_THAN, // (Hrs) meetings longer than this will be skipped
  promptDuration: e.RR_PROMPT_DURATION, // (Secs) display prompt time before room declines invite
  periodicInterval: e.RR_PERIODIC_INTERVAL, // (Mins) duration to perform periodic occupancy checks

  // Webex Notification Options
  webexEnabled: e.RR_WEBEX_ENABLED, // Send message to Webex space when room released
  webexRoomId: e.RR_WEBEX_ROOM_ID, // Webex Messaging Space to send release notifications
  webexBotToken: e.RR_WEBEX_BOT_TOKEN, // Token for Bot account - must be in Space listed above!

  // MS Teams Notification Options
  teamsEnabled: e.RR_TEAMS_ENABLED, // Send message to MS Teams channel when room released
  teamsWebhook: e.RR_TEAMS_WEBHOOK, // URL for Teams Channel Incoming Webhook

  // Other Parameters
  testMode: e.RR_TEST_MODE, // used for testing, prevents the booking from being removed
  playAnnouncement: e.RR_PlAY_ANNOUNCEMENT, // Play announcement tone during check in prompt
  feedbackId: e.RR_FEEDBACK_ID, // identifier assigned to prompt response
  logDetailed: e.LOG_DETAILED, // enable detailed logging
};

const Header = [
  'Content-Type: application/json',
  'Accept: application/json',
];
const webexHeader = [...Header, `Authorization: Bearer ${rrOptions.webexBotToken}`];

// Room Release Class - Instantiated per Device
class RoomRelease {
  constructor(i, id, deviceId, httpService) {
    this.id = id;
    this.deviceId = deviceId;
    this.h = httpService;
    this.active = false;
    this.xapi = i.xapi;
    this.o = rrOptions;
    this.moveAlert = false;
    this.feedbackId = rrOptions.feedbackId;
    this.alertDuration = 0;
    this.alertInterval = null;
    this.deleteTimeout = null;
    this.periodicUpdate = null;
    this.bookingIsActive = false;
    this.countdownActive = false;
    this.listenerShouldCheck = true;
    this.roomIsEmpty = false;
    this.lastFullTimestamp = 0;
    this.lastEmptyTimestamp = 0;
    this.initialDelay = 0;
    this.isRoomOS = false;
    this.metrics = {
      peopleCount: 0,
      peoplePresence: false,
      inCall: false,
      presenceSound: false,
      sharing: false,
    };
    this.sysInfo = {};
  }

  // Post content to Webex Space
  async postWebex(booking, decline) {
    if (this.o.logDetailed) logger.debug(`${this.id}: Process postWebex function`);
    const { Booking } = booking;
    const blockquote = decline.status === 'OK' ? 'success' : 'warning';

    let html = (`<strong>Room Release Notification</strong><blockquote class=${blockquote}><strong>System Name:</strong> ${this.sysInfo.name}<br><strong>Serial Number:</strong> ${this.sysInfo.serial}<br><strong>Platform:</strong> ${this.sysInfo.platform}`);
    let organizer = 'Unknown';
    if (Booking.Organizer) { organizer = Booking.Organizer.LastName !== '' ? `${Booking.Organizer.FirstName} ${Booking.Organizer.LastName}` : Booking.Organizer.FirstName; }
    html += `<br><strong>Organizer:</strong> ${organizer}`;
    html += `<br><strong>Start Time:</strong> ${Booking.Time ? new Date(Booking.Time.StartTime).toString() : 'Unknown'}`;
    html += `<br><strong>Decline Status:</strong> ${decline.status ? decline.status : 'Unknown'}`;

    const messageContent = { roomId: this.o.webexRoomId, html };

    try {
      const result = await this.h.postHttp(this.id, webexHeader, 'https://webexapis.com/v1/messages', messageContent);
      if (/20[04]/.test(result.StatusCode)) {
        if (this.o.logDetailed) logger.debug(`${this.id}: postWebex message sent.`);
        return;
      }
      logger.error(`${this.id}: postWebex status: ${result.StatusCode}`);
      if (result.message && this.o.logDetailed) {
        logger.debug(`${this.id}: ${result.message}`);
      }
    } catch (error) {
      logger.error(`${this.id}: postWebex error`);
      logger.debug(`${this.id}: ${error.message}`);
    }
  }

  // Post content to MS Teams Channel
  async postTeams(booking, decline) {
    if (this.o.logDetailed) logger.debug(`${this.id}: Process postTeams function`);
    const { Booking } = booking;
    const color = decline.status === 'OK' ? 'Good' : 'Warning';
    let organizer = 'Unknown';
    if (Booking.Organizer) { organizer = Booking.Organizer.LastName !== '' ? `${Booking.Organizer.FirstName} ${Booking.Organizer.LastName}` : Booking.Organizer.FirstName; }

    const cardBody = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.3',
            body: [
              {
                type: 'TextBlock',
                text: 'Room Release Notification',
                weight: 'Bolder',
                size: 'Medium',
                color,
              },
              {
                type: 'FactSet',
                facts: [
                  {
                    title: 'System Name',
                    value: this.sysInfo.name,
                  },
                  {
                    title: 'Serial Number',
                    value: this.sysInfo.serial,
                  },
                  {
                    title: 'Platform',
                    value: this.sysInfo.platform,
                  },
                  {
                    title: 'Organizer',
                    value: organizer,
                  },
                  {
                    title: 'Start Time',
                    value: Booking.Time ? new Date(Booking.Time.StartTime).toString() : 'Unknown',
                  },
                  {
                    title: 'Decline Status',
                    value: decline.status ? decline.status : 'Unknown',
                  },
                ],
              },
            ],
          },

        },
      ],
    };

    try {
      const result = await this.h.postHttp(this.id, Header, this.o.teamsWebhook, cardBody);
      if (/20[04]/.test(result.StatusCode)) {
        if (this.o.logDetailed) logger.debug(`${this.id}: postTeams message sent.`);
        return;
      }
      logger.error(`${this.id}: postTeams status: ${result.StatusCode}`);
      if (result.message && this.o.logDetailed) {
        logger.debug(`${this.id}: ${result.message}`);
      }
    } catch (error) {
      logger.error(`${this.id}: postTeams error`);
      logger.debug(`${this.id}: ${error.message}`);
    }
  }

  // Display check in prompt and play announcement tone
  promptUser() {
    this.xapi.command(this.deviceId, 'UserInterface.Message.Prompt.Display', {
      Title: 'Unoccupied Room',
      Text: 'Please Check-In below to retain this Room Booking.',
      FeedbackId: this.feedbackId,
      'Option.1': 'Check-In',
    }).catch((error) => {
      logger.error(`${this.id}: Unable to display Check-in prompt`);
      logger.debug(`${this.id}: ${error.message}`);
    });

    if (!this.o.playAnnouncement) return;
    this.xapi.command(this.deviceId, 'Audio.Sound.Play', {
      Loop: 'Off', Sound: 'Announcement',
    }).catch((error) => {
      logger.error(`${this.id}: Unable to play announcement tone`);
      logger.debug(`${this.id}: ${error.message}`);
    });
  }

  // OSD countdown message for check in
  updateEverySecond() {
    this.alertDuration -= 1;
    if (this.alertDuration <= 0) {
      logger.debug(`${this.id}: Alert duration met.`);
      return;
    }

    const msgBody = {
      text: `Unoccupied Room Alert! It will be released in ${this.alertDuration} seconds.`,
      duration: 0,
    };
    if (!this.moveAlert) {
      msgBody.text = `${msgBody.text}<br>Please use Touch Panel to retain booking.`;
    }
    if (this.moveAlert) {
      msgBody.y = 2000;
      msgBody.x = 5000;
    }
    this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Display', msgBody).catch((error) => {
      logger.error(`${this.id}: Unable to display Check-in prompt`);
      logger.debug(`${this.id}: ${error.message}`);
    });

    // Forced message display every 5 seconds
    if (this.alertDuration % 5 === 0) {
      this.promptUser();
    }
  }

  // Clear existing alerts
  clearAlerts() {
    this.xapi.command(this.deviceId, 'UserInterface.Message.Prompt.Clear', { FeedbackId: this.feedbackId }).catch(() => {});
    this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Clear').catch(() => {});
    clearTimeout(this.deleteTimeout);
    clearInterval(this.alertInterval);
    this.roomIsEmpty = false;
    this.countdownActive = false;
  }

  // Configure Cisco codec for occupancy metrics
  async configureCodec() {
    try {
      const systemUnit = await this.xapi.status.get(this.deviceId, 'SystemUnit.*');
      this.sysInfo.version = systemUnit.Software.Version;
      // verify supported version
      if (!versionCheck(this.sysInfo.version)) throw new Error('Unsupported RoomOS');
      // Determine device mode
      // eslint-disable-next-line no-nested-ternary
      const mtrSupported = /^true$/i.test(systemUnit.Extensions ? systemUnit.Extensions.Microsoft ? systemUnit.Extensions.Microsoft.Supported : false : false);
      if (mtrSupported) {
        const mtrStatus = await this.xapi.command(this.deviceId, 'MicrosoftTeams.List');
        this.isRoomOS = !mtrStatus.Entry.some((i) => i.Status === 'Installed');
        if (!this.isRoomOS) { logger.info(`${this.id}: Device in Microsoft Mode`); }
      }
      // Get System Name / Contact Name
      if (this.isRoomOS) this.sysInfo.name = await this.xapi.status.get(this.deviceId, 'UserInterface.ContactInfo.Name');
      // Get System SN
      this.sysInfo.serial = systemUnit.Hardware.Module.SerialNumber;
      if (!this.sysInfo.name || this.sysInfo.name === '') {
        this.sysInfo.name = this.sysInfo.serial;
      }
      // Get codec platform
      this.sysInfo.platform = await this.xapi.status.get(this.deviceId, 'SystemUnit.ProductPlatform');
      // if matches desk or board series, flag that the on screen alert needs to be moved up
      if (this.sysInfo.platform.toLowerCase().includes('desk') || this.sysInfo.platform.toLowerCase().includes('board')) {
        this.moveAlert = true;
      }
      logger.info('Processing Codec configurations...');
      const configs = {
        'HttpClient.Mode': 'On',
        'RoomAnalytics.PeopleCountOutOfCall': 'On',
        'RoomAnalytics.PeoplePresenceDetector': 'On',
      };
      await this.xapi.config.setMany(this.deviceId, configs);
    } catch (error) {
      logger.debug(`${this.id}: ${error.message}`);
      throw new Error('Config Error');
    }
  }

  // Determine if room is occupied based on enabled detections
  isRoomOccupied() {
    if (this.o.roomInUse) {
      const currentStatus = this.metrics.roomInUse;
      if (this.o.logDetailed) logger.debug(`${this.id}: OCCUPIED: ${currentStatus}`);
      return currentStatus;
    }
    // Legacy Occupancy Calculations
    if (this.o.logDetailed) {
      let message = `${this.id}: Presence: ${this.metrics.peoplePresence} | Count: ${this.metrics.peopleCount}`;
      message += ` | [${this.o.detectActiveCalls ? 'X' : ' '}] In Call: ${this.metrics.inCall}`;
      message += ` | [${this.o.detectSound ? 'X' : ' '}] Sound (> ${this.o.soundLevel}): ${this.metrics.presenceSound}`;
      message += ` | [${this.o.detectPresentation ? 'X' : ' '}] Share: ${this.metrics.sharing}`;
      logger.debug(message);
    }
    const currentStatus = this.metrics.peoplePresence // People presence
      || (this.o.detectActiveCalls && this.metrics.inCall) // Active call detection
      || (this.o.detectSound && this.metrics.presenceSound) // Sound detection
      || (this.o.detectPresentation && this.metrics.sharing); // Presentation detection

    if (this.o.logDetailed) logger.debug(`${this.id}: OCCUPIED: ${currentStatus}`);
    return currentStatus;
  }

  // Countdown timer before meeting decline
  startCountdown() {
    // secondary check to ensure no existing timer is active
    if (this.countdownActive) {
      if (this.o.logDetailed) logger.debug('Countdown already active');
      return;
    }
    if (this.o.logDetailed) logger.debug(`${this.id}: Start countdown initiated`);
    this.countdownActive = true;
    this.promptUser();

    this.alertDuration = this.o.promptDuration;
    // ensure no existing intervalTimer
    clearInterval(this.alertInterval);
    this.alertInterval = setInterval(this.updateEverySecond.bind(this), 1000);

    // Process meeting removal
    clearTimeout(this.deleteTimeout);
    this.deleteTimeout = setTimeout(async () => {
      // clear osd timer
      clearInterval(this.alertInterval);
      // absolute final metrics collection
      await this.getMetrics(false);
      // absolute final occupancy check
      if (this.isRoomOccupied()) {
        logger.info('absolute final occupancy detected, aborting decline!');
        this.clearAlerts();
        this.processOccupancy();
        return;
      }
      if (this.o.logDetailed) logger.debug(`${this.id}: Initiate Booking removal from device.`);
      this.xapi.command(this.deviceId, 'UserInterface.Message.Prompt.Clear', { FeedbackId: this.feedbackId }).catch(() => {});
      this.xapi.command(this.deviceId, 'Audio.Sound.Stop').catch(() => {});
      this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Clear').catch(() => {});
      clearInterval(this.periodicUpdate);

      // We get the updated meetingId to send meeting decline
      let booking;
      let bookingId;
      try {
        // get webex booking id for current booking on codec
        bookingId = await this.xapi.status.get(this.deviceId, 'Bookings.Current.Id');
        if (this.o.logDetailed) logger.debug(`retrieved booking id: ${bookingId}`);
        if (!bookingId) {
          logger.warn(`${bookingId} unable to retrieve current booking id! aborting decline`);
          return;
        }
        // use booking id to retrieve booking data, specifically meeting id
        booking = await this.xapi.command(this.deviceId, 'Bookings.Get', { Id: bookingId });
        if (this.o.logDetailed) logger.debug(`${this.id}: ${bookingId} contains ${booking.Booking.MeetingId}`);
      } catch (error) {
        logger.error(`${this.id}: Unable to retrieve meeting info for ${bookingId}`);
        logger.debug(`${this.id}: ${error.message}`);
        return;
      }
      try {
        let result;
        if (this.o.testMode) {
          if (this.o.logDetailed) logger.info(`${this.id}: Test mode enabled, booking decline skipped.`);
          result = { status: 'Skipped (Test Mode)' };
        } else {
          // attempt decline meeting to control hub
          result = await this.xapi.command(this.deviceId, 'Bookings.Respond', {
            Type: 'Decline',
            MeetingId: booking.Booking.MeetingId,
          });

          if (this.o.logDetailed) logger.debug(`${this.id}: Booking declined.`);
        }
        // Post content to Webex
        if (this.o.webexEnabled) {
          this.postWebex(booking, result);
        }
        // Post content to MS Teams
        if (this.o.teamsEnabled) {
          this.postTeams(booking, result);
        }
      } catch (error) {
        logger.error(`${this.id}: Unable to respond to meeting ${booking.Booking.MeetingId}`);
        logger.debug(`${this.id}: ${error.message}`);
      }
      this.bookingIsActive = false;
      this.lastFullTimestamp = 0;
      this.lastEmptyTimestamp = 0;
      this.roomIsEmpty = false;
      this.countdownActive = false;
    }, (this.o.promptDuration * 1000) + 2000); // 2 second delay to allow for xAPI processing
  }

  // Promise return function
  getData(command) {
    return this.xapi.status.get(this.deviceId, command).catch((error) => {
      logger.warn(`${this.id}: Unable to perform command: ${command}`);
      logger.debug(`${this.id}: ${error.message}`);
      return -1;
    });
  }

  // Poll codec to retrieve updated metrics
  async getMetrics(processResults = true) {
    try {
      if (this.o.roomInUse) {
        const roomInUse = await this.xapi.status.get(this.deviceId, 'RoomAnalytics.RoomInUse');
        this.metrics.roomInUse = /^true$/i.test(roomInUse);
        if (processResults) this.processOccupancy();
        return;
      }
      const metricArray = [this.getData('RoomAnalytics.*')];
      if (this.isRoomOS) {
        metricArray.push(this.getData('SystemUnit.State.NumberOfActiveCalls'));
      } else {
        metricArray.push(this.getData('MicrosoftTeams.Calling.InCall'));
      }

      const results = await Promise.all(metricArray);
      // evaluate the results
      const presence = results[0].PeoplePresence === 'Yes';
      const peopleCount = Number(results[0].PeopleCount.Current);
      const soundResult = Number(results[0].Sound.Level.A);
      const activeCall = this.isRoomOS ? Number(results[1]) > 0 : /^true$/i.test(results[1]);

      // test for local sharing xapi
      const sharing = await this.xapi.status.get(this.deviceId, 'Conference.Presentation.LocalInstance[*].SendingMode', true);
      this.metrics.sharing = !!sharing;

      // Process people metrics
      this.metrics.peopleCount = peopleCount === -1 ? 0 : peopleCount;
      this.metrics.peoplePresence = presence;

      // Process active calls
      if (activeCall && this.o.detectActiveCalls) {
        this.metrics.inCall = true;
        // if in call we assume that people are present
        this.metrics.peoplePresence = true;
      } else {
        this.metrics.inCall = false;
      }

      // Process sound level
      if ((soundResult > this.o.soundLevel) && this.o.detectSound) {
        this.metrics.presenceSound = true;
      } else {
        this.metrics.presenceSound = false;
      }

      if (processResults) this.processOccupancy();
    } catch (error) {
      logger.warn(`${this.id}: Unable to process occupancy metrics from Codec`);
      logger.debug(`${this.id}: ${error.message}`);
    }
  }

  // Process occupancy metrics gathered from the Cisco codec.
  async processOccupancy() {
    // check is room occupied
    if (this.isRoomOccupied()) {
      // is room newly occupied
      if (this.lastFullTimestamp === 0) {
        this.clearAlerts();
        if (this.o.logDetailed) logger.debug(`${this.id}: Room occupancy detected - updating full timestamp...`);
        this.lastFullTimestamp = Date.now();
        this.lastEmptyTimestamp = 0;
      // has room been occupied longer than consideredOccupied
      } else if (Date.now() > (this.lastFullTimestamp + (this.o.consideredOccupied * 60000))) {
        if (this.o.logDetailed) logger.debug(`${this.id}: consideredOccupied reached - room considered occupied`);
        this.roomIsEmpty = false;
        this.lastFullTimestamp = Date.now();
        if (this.o.occupiedStopChecks) {
          // stop further checks as room is considered occupied
          if (this.o.logDetailed) logger.debug(`${this.id}: future checks stopped for this booking`);
          this.bookingIsActive = false;
          this.listenerShouldCheck = false;
          clearInterval(this.periodicUpdate);
        }
      }
    // is room newly empty
    } else if (this.lastEmptyTimestamp === 0) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Room empty detected - updating empty timestamp...`);
      this.lastEmptyTimestamp = Date.now();
      this.lastFullTimestamp = 0;
    // has room been empty longer than emptyBeforeRelease
    } else if (Date.now() > (this.lastEmptyTimestamp + (this.o.emptyBeforeRelease * 60000))
      && !this.roomIsEmpty) {
      if (this.o.logDetailed) logger.debug(`${this.id}: emptyBeforeRelease reached - room considered empty`);
      this.roomIsEmpty = true;
    }

    // if room is considered empty commence countdown (unless already active)
    if (this.roomIsEmpty && !this.countdownActive) {
      // check we have not yet reached the initial delay
      if (Date.now() < this.initialDelay) {
        if (this.o.logDetailed) logger.debug(`${this.id}: Booking removal bypassed as meeting has not yet reached initial delay`);
        return;
      }
      // pre-countdown metrics collection
      await this.getMetrics(false);
      // pre-countdown occupancy check
      if (this.isRoomOccupied()) return;
      logger.warn(`${this.id}: Room is empty start countdown for delete booking`);
      this.startCountdown();
    }
  }

  // Process meeting logic
  async processBooking(id) {
    // Validate booking
    try {
      const availability = await this.xapi.status.get(this.deviceId, 'Bookings.Availability.Status');
      if (availability === 'BookedUntil') {
        const booking = await this.xapi.command(this.deviceId, 'Bookings.Get', { Id: id });
        this.bookingIsActive = true;
        this.listenerShouldCheck = true;

        // Calculate meeting length
        let duration = 0;
        let startTime;
        try {
          const t = booking.Booking.Time;
          startTime = Date.parse(t.StartTime);
          duration = ((Number(t.SecondsUntilEnd) + Number(t.SecondsSinceStart)) / 3600).toFixed(2);
        } catch (error) {
          logger.warn(`${this.id}: Unable to parse Meeting Length`);
          logger.debug(`${this.id}: ${error.message}`);
        }
        // do not process meetings if it equals/exceeds defined meeting length
        if (this.o.logDetailed) logger.debug(`${this.id}: calculated meeting length: ${duration}`);
        if (duration >= this.o.ignoreLongerThan) {
          if (this.o.logDetailed) logger.debug(`${this.id}: meeting ignored as equal/longer than ${this.o.ignoreLongerThan} hours`);
          this.listenerShouldCheck = false;
          this.bookingIsActive = false;
          return;
        }

        // define initial delay before attempting release
        this.initialDelay = startTime + this.o.initialReleaseDelay * 60000;

        // get initial occupancy data from the codec
        await this.getMetrics();

        // Update checks to periodically validate room status.
        clearInterval(this.periodicUpdate);
        this.periodicUpdate = setInterval(() => {
          if (this.o.logDetailed) logger.debug(`${this.id}: initiating periodic processing of occupancy metrics`);
          this.getMetrics();
        }, (this.o.periodicInterval * 60000) + 1000);
      } else {
        this.initialDelay = 0;
        this.lastFullTimestamp = 0;
        this.lastEmptyTimestamp = 0;
        this.roomIsEmpty = false;
        logger.warn(`${this.id}: Booking was detected without end time!`);
      }
    } catch (error) {
      logger.warn(`${this.id}: Unable to process process booking`);
      logger.debug(`${this.id}: ${error.message}`);
    }
  }

  // ----- xAPI Handle Functions ----- //

  handlePromptResponse(event) {
    if (event.FeedbackId === this.feedbackId && event.OptionId === 1) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Local Check-in performed from Touch Panel`);
      this.clearAlerts();
      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;
      if (this.o.buttonStopChecks) {
        if (this.o.logDetailed) logger.debug(`${this.id}: future checks stopped for this booking`);
        this.bookingIsActive = false;
        this.listenerShouldCheck = false;
        clearInterval(this.periodicUpdate);
      }
    }
  }

  handleBookingExtension(id) {
    // Only re-process if meeting and listeners are active
    if (this.bookingIsActive && this.listenerShouldCheck) {
      this.processBooking(id);
    }
  }

  handleBookingEnd() {
    clearInterval(this.periodicUpdate);
    this.clearAlerts();
    this.bookingIsActive = false;
    this.listenerShouldCheck = false;
    this.initialDelay = 0;
    this.lastFullTimestamp = 0;
    this.lastEmptyTimestamp = 0;
  }

  handleActiveCall(status) {
    if (this.bookingIsActive && !this.o.roomInUse) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Number of active calls: ${status}`);
      const inCall = Number(status) > 0;
      this.metrics.inCall = inCall;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleMTRCall(event) {
    if (this.bookingIsActive && !this.o.roomInUse) {
      const result = /^true$/i.test(event);
      if (this.o.logDetailed) logger.debug(`Active MTR Call: ${result}`);
      this.metrics.inCall = result;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeoplePresence(status) {
    if (this.bookingIsActive && !this.o.roomInUse) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Presence: ${status}`);
      const people = status === 'Yes';
      this.metrics.peoplePresence = people;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeopleCount(status) {
    if (this.bookingIsActive && !this.o.roomInUse) {
      if (this.o.logDetailed) logger.debug(`${this.id}: People count: ${status}`);
      const people = Number(status);
      this.metrics.peopleCount = people === -1 ? 0 : people;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleSoundDetection(status) {
    // Only process when enabled to reduce log noise
    if (this.bookingIsActive && this.o.detectSound && !this.o.roomInUse) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Sound level: ${status}`);
      const level = Number(status);
      this.metrics.presenceSound = level > this.o.soundLevel;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePresentationLocalInstance(status) {
    if (this.bookingIsActive && !this.o.roomInUse) {
      if (status.ghost) {
        if (this.o.logDetailed) logger.debug(`${this.id}: Presentation stopped`);
        this.metrics.sharing = false;
      } else {
        if (this.o.logDetailed) logger.debug(`${this.id}: Presentation started: ${status}`);
        this.metrics.sharing = true;
      }

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleInteraction() {
    if (this.bookingIsActive && this.o.detectInteraction && !this.o.roomInUse) {
      if (this.o.logDetailed) logger.debug(`${this.id}: UI interaction detected`);

      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleRoomInUse(status) {
    if (this.bookingIsActive && this.o.roomInUse) {
      const result = /^true$/i.test(status);
      if (this.o.logDetailed) logger.debug(`RoomInUse: ${result}`);
      this.metrics.roomInUse = result;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }
}
exports.Init = RoomRelease;
