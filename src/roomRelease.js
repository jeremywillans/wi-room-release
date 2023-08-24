//
// RoomRelease Module
//

// eslint-disable-next-line object-curly-newline
const { cleanEnv, str, bool, num } = require('envalid');
const logger = require('./logger')('roomRelease');

// Process ENV Parameters
const e = cleanEnv(process.env, {
  // Occupancy Detections
  RR_USE_SOUND: bool({ default: false }),
  RR_USE_ULTRASOUND: bool({ default: false }),
  RR_REQUIRE_ULTRASOUND: bool({ default: false }),
  RR_USE_ACTIVE_CALL: bool({ default: true }),
  RR_USE_INTERACTION: bool({ default: true }),
  RR_USE_PRESENTATION: bool({ default: true }),
  // Disable Occupancy Checks
  RR_BUTTON_STOP_CHECKS: bool({ default: false }),
  RR_OCCUPIED_STOP_CHECKS: bool({ default: false }),
  RR_CONSIDERED_OCCUPIED: num({ default: 15 }), // Minutes
  // Thresholds and Timers
  RR_EMPTY_BEFORE_RELEASE: num({ default: 5 }), // Minutes
  RR_INITIAL_RELEASE_DELAY: num({ default: 10 }), // Minutes
  RR_SOUND_LEVEL: num({ default: 50 }), // dBA
  RR_IGNORE_LONGER_THAN: num({ default: 3 }), // Hours
  RR_PROMPT_DURATION: num({ default: 60 }), // Seconds
  RR_PERIODIC_INTERVAL: num({ default: 2 }), // Minutes
  // Other Parameters
  RR_TEST_MODE: bool({ default: false }),
  RR_PlAY_ANNOUNCEMENT: bool({ default: true }),
  RR_FEEDBACK_ID: str({ default: 'alertResponse' }),
  DEBUG_MODE: bool({ default: true }),
});

// Define Room Release options from ENV Parameters
const rrOptions = {
  // Occupancy Detections
  detectSound: e.RR_USE_SOUND, // Use sound level to consider room occupied (set level below)
  detectUltrasound: e.RR_USE_ULTRASOUND, // Use Ultrasound for presence detection
  requireUltrasound: e.RR_REQUIRE_ULTRASOUND, // Require Ultrasound detection (eg. glass walls)
  detectActiveCalls: e.RR_USE_ACTIVE_CALL, // Use active call for detection (inc airplay)
  detectInteraction: e.RR_USE_INTERACTION, // UI extensions (panel, button, etc) to detect presence.
  detectPresentation: e.RR_USE_PRESENTATION, // Use presentation sharing for detection

  // Disable Occupancy Checks
  // *NOTE* If these are both false, occupancy checks will continue for duration of meeting
  buttonStopChecks: e.RR_BUTTON_STOP_CHECKS, // Stop further occupancy checks after check in
  occupiedStopChecks: e.RR_OCCUPIED_STOP_CHECKS, // Stop periodic checks if room considered occupied
  consideredOccupied: e.RR_CONSIDERED_OCCUPIED, // (Mins) minimum duration until considered occupied

  // Thresholds and Timers
  emptyBeforeRelease: e.RR_EMPTY_BEFORE_RELEASE, // (Mins) time empty until prompt for release
  initialReleaseDelay: e.RR_EMPTY_BEFORE_RELEASE, // (Mins) initial delay before prompt for release
  soundLevel: e.RR_SOUND_LEVEL, // (dB) Minimum sound level required to consider occupied
  ignoreLongerThan: e.RR_IGNORE_LONGER_THAN, // (Hrs) meetings longer than this will be skipped
  promptDuration: e.RR_PROMPT_DURATION, // (Secs) display prompt time before room declines invite
  periodicInterval: e.RR_PERIODIC_INTERVAL, // (Mins) duration to perform periodic occupancy checks

  // Other Parameters
  testMode: e.RR_TEST_MODE, // used for testing, prevents the booking from being removed
  playAnnouncement: e.RR_PlAY_ANNOUNCEMENT, // Play announcement tone during check in prompt
  feedbackId: e.RR_FEEDBACK_ID, // identifier assigned to prompt response
  debugMode: e.DEBUG_MODE, // Enable debug logging
};

// Enable Ultrasound if set to required (and not enabled)
if (rrOptions.requireUltrasound && !rrOptions.detectUltrasound) {
  logger.warn('Ultrasound required but disabled, activating...');
  rrOptions.detectUltrasound = true;
}

// Room Release Class - Instantiated per Device
class RoomRelease {
  constructor(i, id, deviceId) {
    this.xapi = i.xapi;
    this.id = id;
    this.deviceId = deviceId;
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
    this.metrics = {
      peopleCount: 0,
      peoplePresence: false,
      ultrasound: false,
      inCall: false,
      presenceSound: false,
      sharing: false,
    };
  }

  // Display check in prompt and play announcement tone
  promptUser() {
    this.xapi.command(this.deviceId, 'UserInterface.Message.Prompt.Display', {
      Title: 'Unoccupied Room',
      Text: 'Please Check-In below to retain this Room Booking.',
      FeedbackId: this.feedbackId,
      'Option.1': 'Check-In',
    }).catch((error) => { logger.error(`${this.id}: ${error.message}`); });

    if (!this.o.playAnnouncement) return;
    this.xapi.command(this.deviceId, 'Audio.Sound.Play', {
      Loop: 'Off', Sound: 'Announcement',
    }).catch((error) => { logger.error(`${this.id}: ${error.message}`); });
  }

  // OSD countdown message for check in
  updateEverySecond() {
    this.alertDuration -= 1;
    if (this.alertDuration <= 0) {
      clearInterval(this.alertInterval);
      this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Clear');
      return;
    }

    const msgBody = {
      text: `Unoccupied Room Alert! It will be released in ${this.alertDuration} seconds.<br>Please use Touch Panel to retain booking.`,
      duration: 0,
    };
    if (this.moveAlert) {
      msgBody.y = 2000;
      msgBody.x = 5000;
    }
    this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Display', msgBody)
      .catch((error) => { logger.error(`${this.id}: ${error.message}`); });

    // Forced message display every 5 seconds
    if (this.alertDuration % 5 === 0) {
      this.promptUser();
    }
  }

  // Clear existing alerts
  clearAlerts() {
    this.xapi.command(this.deviceId, 'UserInterface.Message.Prompt.Clear', { FeedbackId: this.feedbackId });
    this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Clear');
    clearTimeout(this.deleteTimeout);
    clearInterval(this.alertInterval);
    this.roomIsEmpty = false;
    this.countdownActive = false;
  }

  // Configure Cisco codec for occupancy metrics
  async configureCodec() {
    try {
      // Get codec platform
      const platform = await this.xapi.status.get(this.deviceId, 'SystemUnit.ProductPlatform');
      // if matches desk or board series, flag that the on screen alert needs to be moved up
      if (platform.toLowerCase().includes('desk') || platform.toLowerCase().includes('board')) {
        this.moveAlert = true;
      }
      const configs = {
        'HttpClient.Mode': 'On',
        'RoomAnalytics.PeopleCountOutOfCall': 'On',
        'RoomAnalytics.PeoplePresenceDetector': 'On',
      };
      await this.xapi.config.setMany(this.deviceId, configs);
    } catch (error) {
      logger.warn(error.message);
    }
  }

  // Determine if room is occupied based on enabled detections
  isRoomOccupied() {
    if (this.o.debugMode) {
      let message = `${this.id}: Presence: ${this.metrics.peoplePresence} | Count: ${this.metrics.peopleCount}`;
      // eslint-disable-next-line no-nested-ternary
      message += ` | [${this.o.requireUltrasound ? 'R' : this.o.requireUltrasound ? 'X' : ' '}] Ultrasound: ${this.metrics.ultrasound}`;
      message += ` | [${this.o.detectActiveCalls ? 'X' : ' '}] In Call: ${this.metrics.inCall}`;
      message += ` | [${this.o.detectSound ? 'X' : ' '}] Sound (> ${this.o.soundLevel}): ${this.metrics.presenceSound}`;
      message += ` | [${this.o.detectPresentation ? 'X' : ' '}] Share: ${this.metrics.sharing}`;
      logger.debug(message);
    }
    let currentStatus = this.metrics.peoplePresence // People presence
      || (this.o.detectActiveCalls && this.metrics.inCall) // Active call detection
      || (this.o.detectSound && this.metrics.presenceSound) // Sound detection
      || (this.o.detectPresentation && this.metrics.sharing) // Presentation detection
      || (this.o.detectUltrasound && this.metrics.ultrasound); // Ultrasound detection

    // If ultrasound is required, test against people presence status
    if (this.o.requireUltrasound && this.metrics.peoplePresence) {
      currentStatus = this.metrics.peoplePresence && this.metrics.ultrasound;
    }

    if (this.o.debugMode) logger.debug(`${this.id}: OCCUPIED: ${currentStatus}`);
    return currentStatus;
  }

  // Countdown timer before meeting decline
  startCountdown() {
    if (this.o.debugMode) logger.debug(`${this.id}: Start countdown initiated`);
    this.countdownActive = true;
    this.promptUser();

    this.alertDuration = this.o.promptDuration;
    this.alertInterval = setInterval(this.updateEverySecond.bind(this), 1000);

    // Process meeting removal
    this.deleteTimeout = setTimeout(async () => {
      // absolute final metrics collection
      await this.getMetrics(false);
      // absolute final occupancy check
      if (this.isRoomOccupied()) {
        logger.info('absolute final occupancy detected, aborting decline!');
        this.clearAlerts();
        this.processOccupancy();
        return;
      }
      if (this.o.debugMode) logger.debug(`${this.id}: Initiate Booking removal from device.`);
      this.xapi.command(this.deviceId, 'UserInterface.Message.Prompt.Clear', { FeedbackId: this.feedbackId });
      this.xapi.command(this.deviceId, 'Audio.Sound.Stop');
      this.xapi.command(this.deviceId, 'UserInterface.Message.TextLine.Clear');
      clearInterval(this.periodicUpdate);

      // We get the updated meetingId to send meeting decline
      let booking;
      let bookingId;
      try {
        // get webex booking id for current booking on codec
        bookingId = await this.xapi.status.get(this.deviceId, 'Bookings.Current.Id');
        // use booking id to retrieve booking data, specifically meeting id
        booking = await this.xapi.command(this.deviceId, 'Bookings.Get', { Id: bookingId });
        if (this.o.debugMode) logger.debug(`${this.id}: ${bookingId} contains ${booking.Booking.MeetingId}`);
      } catch (error) {
        logger.error(`${this.id}: Unable to retrieve meeting info for ${bookingId}`);
        if (this.o.debugMode) logger.debug(`${this.id}: ${error.message}`);
        return;
      }
      try {
        if (this.o.testMode) {
          if (this.o.debugMode) logger.info(`${this.id}: Test mode enabled, booking decline skipped.`);
        } else {
          // attempt decline meeting to control hub
          await this.xapi.command(this.deviceId, 'Bookings.Respond', {
            Type: 'Decline',
            MeetingId: booking.Booking.MeetingId,
          });
          if (this.o.debugMode) logger.debug(`${this.id}: Booking declined.`);
        }
      } catch (error) {
        logger.error(`${this.id}: Unable to respond to meeting ${booking.Booking.MeetingId}`);
        if (this.o.debugMode) logger.debug(`${this.id}: ${error.message}`);
      }
      this.bookingIsActive = false;
      this.lastFullTimestamp = 0;
      this.lastEmptyTimestamp = 0;
      this.roomIsEmpty = false;
    }, (this.o.promptDuration * 1000) + 2000); // 2 second delay to allow for xAPI processing
  }

  // Promise return function
  getData(command) {
    return this.xapi.status.get(this.deviceId, command).catch((error) => {
      logger.warn(`${this.id}: Unable to perform command: ${command}`);
      if (this.o.debugMode) logger.debug(`${this.id}: ${error.message}`);
      return -1;
    });
  }

  // Poll codec to retrieve updated metrics
  async getMetrics(processResults = true) {
    try {
      const results = await Promise.all([
        this.getData('SystemUnit.State.NumberOfActiveCalls'),
        this.getData('RoomAnalytics.UltrasoundPresence'),
        this.getData('RoomAnalytics.PeoplePresence'),
        this.getData('RoomAnalytics.PeopleCount.Current'),
        this.getData('RoomAnalytics.Sound.Level.A'),
      ]);
      // process results
      const numCalls = Number(results[0]);
      const ultrasound = results[1] === 'Yes';
      const presence = results[2] === 'Yes';
      const peopleCount = Number(results[3]);
      const soundResult = Number(results[4]);

      // test for local sharing xapi
      const sharing = await this.xapi.status.get(this.deviceId, 'Conference.Presentation.LocalInstance[*].SendingMode', true);
      this.metrics.sharing = !!sharing;

      // Process people metrics
      this.metrics.peopleCount = peopleCount === -1 ? 0 : peopleCount;
      this.metrics.peoplePresence = presence;
      this.metrics.ultrasound = ultrasound;

      // Process active calls
      if (numCalls > 0 && this.o.detectActiveCalls) {
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
      if (this.o.debugMode) logger.debug(`${this.id}: ${error.message}`);
    }
  }

  // Process occupancy metrics gathered from the Cisco codec.
  async processOccupancy() {
    // check is room occupied
    if (this.isRoomOccupied()) {
      // is room newly occupied
      if (this.lastFullTimestamp === 0) {
        if (this.o.debugMode) logger.debug(`${this.id}: Room occupancy detected - updating full timestamp...`);
        this.lastFullTimestamp = Date.now();
        this.lastEmptyTimestamp = 0;
      // has room been occupied longer than consideredOccupied
      } else if (Date.now() > (this.lastFullTimestamp + (this.o.consideredOccupied * 60000))) {
        if (this.o.debugMode) logger.debug(`${this.id}: consideredOccupied reached - room considered occupied`);
        this.roomIsEmpty = false;
        this.lastFullTimestamp = Date.now();
        if (this.o.occupiedStopChecks) {
          // stop further checks as room is considered occupied
          if (this.o.debugMode) logger.debug(`${this.id}: future checks stopped for this booking`);
          this.bookingIsActive = false;
          this.listenerShouldCheck = false;
          clearInterval(this.periodicUpdate);
        }
      }
    // is room newly empty
    } else if (this.lastEmptyTimestamp === 0) {
      if (this.o.debugMode) logger.debug(`${this.id}: Room empty detected - updating empty timestamp...`);
      this.lastEmptyTimestamp = Date.now();
      this.lastFullTimestamp = 0;
    // has room been empty longer than emptyBeforeRelease
    } else if (Date.now() > (this.lastEmptyTimestamp + (this.o.emptyBeforeRelease * 60000))
      && !this.roomIsEmpty) {
      if (this.o.debugMode) logger.debug(`${this.id}: emptyBeforeRelease reached - room considered empty`);
      this.roomIsEmpty = true;
    }

    // if room is considered empty commence countdown (unless already active)
    if (this.roomIsEmpty && !this.countdownActive) {
      // check we have not yet reached the initial delay
      if (Date.now() < this.initialDelay) {
        if (this.o.debugMode) logger.debug(`${this.id}: Booking removal bypassed as meeting has not yet reached initial delay`);
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
        if (this.o.debugMode) logger.debug(`${this.id}: ${error.message}`);
      }
      // do not process meetings if it equals/exceeds defined meeting length
      if (this.o.debugMode) logger.debug(`${this.id}: calculated meeting length: ${duration}`);
      if (duration >= this.o.ignoreLongerThan) {
        if (this.o.debugMode) logger.debug(`${this.id}: meeting ignored as equal/longer than ${this.o.ignoreLongerThan} hours`);
        this.listenerShouldCheck = false;
        this.bookingIsActive = false;
        return;
      }

      // define initial delay before attempting release
      this.initialDelay = startTime + this.o.initialReleaseDelay * 60000;

      // get initial occupancy data from the codec
      await this.getMetrics();

      // Update checks to periodically validate room status.
      this.periodicUpdate = setInterval(() => {
        if (this.o.debugMode) logger.debug(`${this.id}: initiating periodic processing of occupancy metrics`);
        this.getMetrics();
      }, (this.o.periodicInterval * 60000) + 1000);
    } else {
      this.initialDelay = 0;
      this.lastFullTimestamp = 0;
      this.lastEmptyTimestamp = 0;
      this.roomIsEmpty = false;
      logger.warn(`${this.id}: Booking was detected without end time!`);
    }
  }

  // ----- xAPI Handle Functions ----- //

  handlePromptResponse(event) {
    if (event.FeedbackId === this.feedbackId && event.OptionId === 1) {
      if (this.o.debugMode) logger.debug(`${this.id}: Local Check-in performed from Touch Panel`);
      this.clearAlerts();
      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;
      if (this.o.buttonStopChecks) {
        if (this.o.debugMode) logger.debug(`${this.id}: future checks stopped for this booking`);
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

  handleActiveCall(result) {
    if (this.bookingIsActive) {
      if (this.o.debugMode) logger.debug(`${this.id}: Number of active calls: ${result}`);
      const inCall = Number(result) > 0;
      this.metrics.inCall = inCall;

      if (this.o.detectActiveCalls && inCall) {
        this.clearAlerts();
      }
      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeoplePresence(result) {
    if (this.bookingIsActive) {
      if (this.o.debugMode) logger.debug(`${this.id}: Presence: ${result}`);
      const people = result === 'Yes';
      this.metrics.peoplePresence = people;

      if (people) {
        this.clearAlerts();
      }
      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleUltrasoundPresence(result) {
    if (this.bookingIsActive) {
      if (this.o.debugMode) logger.debug(`${this.id}: Ultrasound: ${result}`);
      const ultrasound = result === 'Yes';
      this.metrics.ultrasound = ultrasound;

      if (this.o.detectUltrasound && ultrasound) {
        this.clearAlerts();
      }
      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeopleCount(result) {
    if (this.bookingIsActive) {
      if (this.o.debugMode) logger.debug(`${this.id}: People count: ${result}`);
      const people = Number(result);
      this.metrics.peopleCount = people === -1 ? 0 : people;

      if (people > 0) {
        this.clearAlerts();
      }
      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleSoundDetection(result) {
    // Only process when enabled to reduce log noise
    if (this.bookingIsActive && this.o.detectSound) {
      if (this.o.debugMode) logger.debug(`${this.id}: Sound level: ${result}`);
      const level = Number(result);
      this.metrics.presenceSound = level > this.o.soundLevel;

      if (level > this.o.soundLevel) {
        this.clearAlerts();
      }
      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePresentationLocalInstance(result) {
    if (this.bookingIsActive) {
      if (result.ghost) {
        if (this.o.debugMode) logger.debug(`${this.id}: Presentation stopped`);
        this.metrics.sharing = false;
      } else {
        if (this.o.debugMode) logger.debug(`${this.id}: Presentation started: ${result}`);
        this.metrics.sharing = true;
      }

      if (this.o.detectPresentation) {
        this.clearAlerts();
      }
      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleInteraction() {
    if (this.bookingIsActive && this.o.detectInteraction) {
      if (this.o.debugMode) logger.debug(`${this.id}: UI interaction detected`);

      this.clearAlerts();
      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }
}
exports.RoomRelease = RoomRelease;
