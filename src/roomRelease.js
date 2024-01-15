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
  RR_USE_SOUND: bool({ default: false }),
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
  // Webex Notification Options
  RR_SEND_MESSAGE: bool({ default: false }),
  RR_ROOM_ID: str({ default: undefined }),
  RR_BOT_TOKEN: str({ default: undefined }),
  // Other Parameters
  RR_TEST_MODE: bool({ default: false }),
  RR_PlAY_ANNOUNCEMENT: bool({ default: true }),
  RR_FEEDBACK_ID: str({ default: 'alertResponse' }),
});

// Define Room Release options from ENV Parameters
const rrOptions = {
  // Occupancy Detections
  detectSound: e.RR_USE_SOUND, // Use sound level to consider room occupied (set level below)
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

  // Webex Notification Options
  sendMessage: e.RR_SEND_MESSAGE, // Send message to Webex space when room released
  roomId: e.RR_ROOM_ID, // Webex Messaging Space to send release notifications
  botToken: e.RR_BOT_TOKEN, // Token for Bot account - must be in Space listed above!

  // Other Parameters
  testMode: e.RR_TEST_MODE, // used for testing, prevents the booking from being removed
  playAnnouncement: e.RR_PlAY_ANNOUNCEMENT, // Play announcement tone during check in prompt
  feedbackId: e.RR_FEEDBACK_ID, // identifier assigned to prompt response
  logDetailed: e.LOG_DETAILED, // enable detailed logging
};

// Room Release Class - Instantiated per Device
class RoomRelease {
  constructor(i, id, deviceId, httpService) {
    this.xapi = i.xapi;
    this.id = id;
    this.deviceId = deviceId;
    this.o = rrOptions;
    this.httpService = httpService;
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
      inCall: false,
      presenceSound: false,
      sharing: false,
    };
    this.sysInfo = {};
  }

  // Post content to Webex Space
  async postContent(booking, result) {
    if (this.o.logDetailed) logger.debug(`${this.id}: Prepare send webex message`);
    const { Booking } = booking;
    const blockquote = result.status === 'OK' ? 'success' : 'warning';

    let html = (`<strong>Room Release Notification</strong><blockquote class=${blockquote}><strong>System Name:</strong> ${this.sysInfo.name}<br><strong>Serial Number:</strong> ${this.sysInfo.serial}<br><strong>Platform:</strong> ${this.sysInfo.platform}`);
    let organizer = 'Unknown';
    if (Booking.Organizer) { organizer = Booking.Organizer.LastName !== '' ? `${Booking.Organizer.FirstName} ${Booking.Organizer.LastName}` : Booking.Organizer.FirstName; }
    html += `<br><strong>Organizer:</strong> ${organizer}`;
    html += `<br><strong>Start Time:</strong> ${Booking.Time ? new Date(Booking.Time.StartTime) : 'Unknown'}`;
    html += `<br><strong>Decline Status:</strong> ${result.status ? result.status : 'Unknown'}`;

    try {
      await this.httpService.postMessage(this.o.botToken, this.o.roomId, html, 'html');
      if (this.o.logDetailed) logger.debug(`${this.id}: message sent.`);
    } catch (error) {
      logger.error(`${this.id}: error sending message`);
      logger.debug(`${this.id}: send message error: ${error.message}`);
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
      text: `Unoccupied Room Alert! It will be released in ${this.alertDuration} seconds.<br>Please use Touch Panel to retain booking.`,
      duration: 0,
    };
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
      // Get system / contact name
      this.sysInfo.name = await this.xapi.status.get(this.deviceId, 'UserInterface.ContactInfo.Name');
      // Get system serial
      this.sysInfo.serial = await this.xapi.status.get(this.deviceId, 'SystemUnit.Hardware.Module.SerialNumber');
      if (this.sysInfo.name === '') {
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
      logger.error(`${this.id}: Unable to configure codec`);
      logger.debug(`${this.id}: ${error.message}`);
    }
  }

  // Determine if room is occupied based on enabled detections
  isRoomOccupied() {
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
          result = { Status: 'Skipped (Test Mode)' };
        } else {
          // attempt decline meeting to control hub
          result = await this.xapi.command(this.deviceId, 'Bookings.Respond', {
            Type: 'Decline',
            MeetingId: booking.Booking.MeetingId,
          });
          if (this.o.logDetailed) logger.debug(`${this.id}: Booking declined.`);
        }
        // Post content to Webex
        if (this.o.sendMessage) {
          this.postContent(booking, result);
        }
      } catch (error) {
        logger.error(`${this.id}: Unable to respond to meeting ${booking.Booking.MeetingId}`);
        logger.debug(`${this.id}: ${error.message}`);
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
      logger.debug(`${this.id}: ${error.message}`);
      return -1;
    });
  }

  // Poll codec to retrieve updated metrics
  async getMetrics(processResults = true) {
    try {
      const results = await Promise.all([
        this.getData('SystemUnit.State.NumberOfActiveCalls'),
        this.getData('RoomAnalytics.*'),
      ]);

      // evaluate the results
      const numCalls = Number(results[0]);
      const presence = results[1].PeoplePresence === 'Yes';
      const peopleCount = Number(results[1].PeopleCount.Current);
      const soundResult = Number(results[1].Sound.Level.A);

      // test for local sharing xapi
      const sharing = await this.xapi.status.get(this.deviceId, 'Conference.Presentation.LocalInstance[*].SendingMode', true);
      this.metrics.sharing = !!sharing;

      // Process people metrics
      this.metrics.peopleCount = peopleCount === -1 ? 0 : peopleCount;
      this.metrics.peoplePresence = presence;

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

  handleActiveCall(result) {
    if (this.bookingIsActive) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Number of active calls: ${result}`);
      const inCall = Number(result) > 0;
      this.metrics.inCall = inCall;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeoplePresence(result) {
    if (this.bookingIsActive) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Presence: ${result}`);
      const people = result === 'Yes';
      this.metrics.peoplePresence = people;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeopleCount(result) {
    if (this.bookingIsActive) {
      if (this.o.logDetailed) logger.debug(`${this.id}: People count: ${result}`);
      const people = Number(result);
      this.metrics.peopleCount = people === -1 ? 0 : people;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleSoundDetection(result) {
    // Only process when enabled to reduce log noise
    if (this.bookingIsActive && this.o.detectSound) {
      if (this.o.logDetailed) logger.debug(`${this.id}: Sound level: ${result}`);
      const level = Number(result);
      this.metrics.presenceSound = level > this.o.soundLevel;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePresentationLocalInstance(result) {
    if (this.bookingIsActive) {
      if (result.ghost) {
        if (this.o.logDetailed) logger.debug(`${this.id}: Presentation stopped`);
        this.metrics.sharing = false;
      } else {
        if (this.o.logDetailed) logger.debug(`${this.id}: Presentation started: ${result}`);
        this.metrics.sharing = true;
      }

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleInteraction() {
    if (this.bookingIsActive && this.o.detectInteraction) {
      if (this.o.logDetailed) logger.debug(`${this.id}: UI interaction detected`);

      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }
}
exports.RoomRelease = RoomRelease;
