/* eslint-disable class-methods-use-this */
/* eslint-disable no-console */
/*
# Room Release Macro
# Written by Jeremy Willans
# https://github.com/jeremywillans/wi-room-release
# Version: 0.0.5
#
# USE AT OWN RISK, MACRO NOT FULLY TESTED NOR SUPPLIED WITH ANY GUARANTEE
#
# Usage - Automatically releases a room booking based on occupancy metrics from the Cisco codec
#
# Credit - rudferna@cisco.com, as the original author of the room release macro
#
*/
// eslint-disable-next-line import/no-unresolved
import xapi from 'xapi';

const rrOptions = {
  // Occupancy Detections
  detectSound: false, // Use sound level to consider room occupied (set level below)
  detectActiveCalls: true, // Use active call for detection (inc airplay)
  detectInteraction: true, // UI extensions (panel, button, etc) to detect presence.
  detectPresentation: true, // Use presentation sharing for detection

  // Disable Occupancy Checks
  // *NOTE* If these are both false, occupancy checks will continue for duration of meeting
  buttonStopChecks: false, // Stop further occupancy checks after check in
  occupiedStopChecks: false, // Stop periodic checks if room considered occupied
  consideredOccupied: 15, // (Mins) minimum duration until considered occupied

  // Thresholds and Timers
  emptyBeforeRelease: 5, // (Mins) time empty until prompt for release
  initialReleaseDelay: 10, // (Mins) initial delay before prompt for release
  soundLevel: 50, // (dB) Minimum sound level required to consider occupied
  ignoreLongerThan: 5, // (Hrs) meetings longer than this will be skipped
  promptDuration: 60, // (Secs) display prompt time before room declines invite
  periodicInterval: 2, // (Mins) duration to perform periodic occupancy checks

  // Other Parameters
  testMode: false, // used for testing, prevents the booking from being removed
  playAnnouncement: true, // Play announcement tone during check in prompt
  feedbackId: 'alertResponse', // identifier assigned to prompt response
  logDetailed: true, // enable detailed logging
};

// ----- EDIT BELOW THIS LINE AT OWN RISK ----- //

// Room Release Class
class RoomRelease {
  constructor() {
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
      inCall: false,
      presenceSound: false,
      sharing: false,
    };
  }

  // Display check in prompt and play announcement tone
  promptUser() {
    xapi.command('UserInterface.Message.Prompt.Display', {
      Title: 'Unoccupied Room',
      Text: 'Please Check-In below to retain this Room Booking.',
      FeedbackId: this.feedbackId,
      'Option.1': 'Check-In',
    }).catch((error) => {
      console.error('Unable to display Check-in prompt');
      console.debug(error.message);
    });

    if (!this.o.playAnnouncement) return;
    xapi.command('Audio.Sound.Play', {
      Loop: 'Off', Sound: 'Announcement',
    }).catch((error) => {
      console.error('Unable to play announcement tone');
      console.debug(error.message);
    });
  }

  // OSD countdown message for check in
  updateEverySecond() {
    this.alertDuration -= 1;
    if (this.alertDuration <= 0) {
      console.debug('Alert duration met.');
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
    xapi.command('UserInterface.Message.TextLine.Display', msgBody).catch((error) => {
      console.error('Unable to display Check-in prompt');
      console.debug(error.message);
    });

    // Forced message display every 5 seconds
    if (this.alertDuration % 5 === 0) {
      this.promptUser();
    }
  }

  // Clear existing alerts
  clearAlerts() {
    xapi.command('UserInterface.Message.Prompt.Clear', { FeedbackId: this.feedbackId }).catch(() => {});
    xapi.command('UserInterface.Message.TextLine.Clear').catch(() => {});
    clearTimeout(this.deleteTimeout);
    clearInterval(this.alertInterval);
    this.roomIsEmpty = false;
    this.countdownActive = false;
  }

  // Configure Cisco codec for occupancy metrics
  async configureCodec() {
    try {
      // Get codec platform
      const platform = await xapi.status.get('SystemUnit.ProductPlatform');
      // if matches desk or board series, flag that the on screen alert needs to be moved up
      if (platform.toLowerCase().includes('desk') || platform.toLowerCase().includes('board')) {
        this.moveAlert = true;
      }
      console.info('Processing Codec configurations...');
      await xapi.config.set('HttpClient.Mode', 'On');
      await xapi.config.set('RoomAnalytics.PeopleCountOutOfCall', 'On');
      await xapi.config.set('RoomAnalytics.PeoplePresenceDetector', 'On');
    } catch (error) {
      console.error('Unable to configure codec');
      console.warn(error.message);
    }
  }

  // Determine if room is occupied based on enabled detections
  isRoomOccupied() {
    if (this.o.logDetailed) {
      let message = `Presence: ${this.metrics.peoplePresence} | Count: ${this.metrics.peopleCount}`;
      message += ` | [${this.o.detectActiveCalls ? 'X' : ' '}] In Call: ${this.metrics.inCall}`;
      message += ` | [${this.o.detectSound ? 'X' : ' '}] Sound (> ${this.o.soundLevel}): ${this.metrics.presenceSound}`;
      message += ` | [${this.o.detectPresentation ? 'X' : ' '}] Share: ${this.metrics.sharing}`;
      console.debug(message);
    }
    const currentStatus = this.metrics.peoplePresence // People presence
      || (this.o.detectActiveCalls && this.metrics.inCall) // Active call detection
      || (this.o.detectSound && this.metrics.presenceSound) // Sound detection
      || (this.o.detectPresentation && this.metrics.sharing); // Presentation detection

    if (this.o.logDetailed) console.debug(`OCCUPIED: ${currentStatus}`);
    return currentStatus;
  }

  // Countdown timer before meeting decline
  startCountdown() {
    if (this.o.logDetailed) console.debug('Start countdown initiated');
    this.countdownActive = true;
    this.promptUser();

    this.alertDuration = this.o.promptDuration;
    this.alertInterval = setInterval(this.updateEverySecond.bind(this), 1000);

    // Process meeting removal
    this.deleteTimeout = setTimeout(async () => {
      // clear osd timer
      clearInterval(this.alertInterval);
      // absolute final metrics collection
      await this.getMetrics(false);
      // absolute final occupancy check
      if (this.isRoomOccupied()) {
        console.info('absolute final occupancy detected, aborting decline!');
        this.clearAlerts();
        this.processOccupancy();
        return;
      }
      if (this.o.logDetailed) console.debug('Initiate Booking removal from device.');
      xapi.command('UserInterface.Message.Prompt.Clear', { FeedbackId: this.feedbackId }).catch(() => {});
      xapi.command('Audio.Sound.Stop').catch(() => {});
      xapi.command('UserInterface.Message.TextLine.Clear').catch(() => {});
      clearInterval(this.periodicUpdate);

      // We get the updated meetingId to send meeting decline
      let booking;
      let bookingId;
      try {
        // get webex booking id for current booking on codec
        bookingId = await xapi.status.get('Bookings.Current.Id');
        // use booking id to retrieve booking data, specifically meeting id
        booking = await xapi.command('Bookings.Get', { Id: bookingId });
        if (this.o.logDetailed) console.debug(`${bookingId} contains ${booking.Booking.MeetingId}`);
      } catch (error) {
        console.error(`Unable to retrieve meeting info for ${bookingId}`);
        console.debug(error.message);
        return;
      }
      try {
        if (this.o.testMode) {
          if (this.o.logDetailed) console.info('Test mode enabled, booking decline skipped.');
        } else {
          // attempt decline meeting to control hub
          await xapi.command('Bookings.Respond', {
            Type: 'Decline',
            MeetingId: booking.Booking.MeetingId,
          });
          if (this.o.logDetailed) console.debug('Booking declined.');
        }
      } catch (error) {
        console.error(`Unable to respond to meeting ${booking.Booking.MeetingId}`);
        console.debug(error.message);
      }
      this.bookingIsActive = false;
      this.lastFullTimestamp = 0;
      this.lastEmptyTimestamp = 0;
      this.roomIsEmpty = false;
    }, this.o.promptDuration * 1000);
  }

  // Promise return function
  getData(command) {
    return xapi.status.get(command).catch((error) => {
      console.warn(`Unable to perform command: ${command}`);
      console.debug(error.message);
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
      const sharing = await this.getData('Conference.Presentation.LocalInstance');
      this.metrics.sharing = sharing.length > 0;

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
      console.warn('Unable to process occupancy metrics from Codec');
      console.debug(error.message);
    }
  }

  // Process occupancy metrics gathered from the Cisco codec.
  async processOccupancy() {
    // check is room occupied
    if (this.isRoomOccupied()) {
      // is room newly occupied
      if (this.lastFullTimestamp === 0) {
        this.clearAlerts();
        if (this.o.logDetailed) console.debug('Room occupancy detected - updating full timestamp...');
        this.lastFullTimestamp = Date.now();
        this.lastEmptyTimestamp = 0;
      // has room been occupied longer than consideredOccupied
      } else if (Date.now() > (this.lastFullTimestamp + (this.o.consideredOccupied * 60000))) {
        if (this.o.logDetailed) console.debug('consideredOccupied reached - room considered occupied');
        this.roomIsEmpty = false;
        this.lastFullTimestamp = Date.now();
        if (this.o.occupiedStopChecks) {
          // stop further checks as room is considered occupied
          if (this.o.logDetailed) console.debug('future checks stopped for this booking');
          this.bookingIsActive = false;
          this.listenerShouldCheck = false;
          clearInterval(this.periodicUpdate);
        }
      }
    // is room newly empty
    } else if (this.lastEmptyTimestamp === 0) {
      if (this.o.logDetailed) console.debug('Room empty detected - updating empty timestamp...');
      this.lastEmptyTimestamp = Date.now();
      this.lastFullTimestamp = 0;
    // has room been empty longer than emptyBeforeRelease
    } else if (Date.now() > (this.lastEmptyTimestamp + (this.o.emptyBeforeRelease * 60000))
      && !this.roomIsEmpty) {
      if (this.o.logDetailed) console.debug('emptyBeforeRelease reached - room considered empty');
      this.roomIsEmpty = true;
    }

    // if room is considered empty commence countdown (unless already active)
    if (this.roomIsEmpty && !this.countdownActive) {
      // check we have not yet reached the initial delay
      if (Date.now() < this.initialDelay) {
        if (this.o.logDetailed) console.debug('Booking removal bypassed as meeting has not yet reached initial delay');
        return;
      }
      // pre-countdown metrics collection
      await this.getMetrics(false);
      // pre-countdown occupancy check
      if (this.isRoomOccupied()) return;
      console.warn('Room is empty start countdown for delete booking');
      this.startCountdown();
    }
  }

  // Process meeting logic
  async processBooking(id) {
    // Validate booking
    try {
      const availability = await xapi.status.get('Bookings.Availability.Status');
      if (availability === 'BookedUntil') {
        const booking = await xapi.command('Bookings.Get', { Id: id });
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
          console.warn('Unable to parse Meeting Length');
          console.debug(error.message);
        }
        // do not process meetings if it equals/exceeds defined meeting length
        if (this.o.logDetailed) console.debug(`calculated meeting length: ${duration}`);
        if (duration >= this.o.ignoreLongerThan) {
          if (this.o.logDetailed) console.debug(`meeting ignored as equal/longer than ${this.o.ignoreLongerThan} hours`);
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
          if (this.o.logDetailed) console.debug('initiating periodic processing of occupancy metrics');
          this.getMetrics();
        }, (this.o.periodicInterval * 60000) + 1000);
      } else {
        this.initialDelay = 0;
        this.lastFullTimestamp = 0;
        this.lastEmptyTimestamp = 0;
        this.roomIsEmpty = false;
        console.warn('Booking was detected without end time!');
      }
    } catch (error) {
      console.warn('Unable to process process booking');
      console.debug(error.message);
    }
  }

  // ----- xAPI Handle Functions ----- //

  handlePromptResponse(event) {
    if (event.FeedbackId === this.feedbackId && event.OptionId === '1') {
      if (this.o.logDetailed) console.debug('Local Check-in performed from Touch Panel');
      this.clearAlerts();
      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;
      if (this.o.buttonStopChecks) {
        if (this.o.logDetailed) console.debug('future checks stopped for this booking');
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
      if (this.o.logDetailed) console.debug(`Number of active calls: ${result}`);
      const inCall = Number(result) > 0;
      this.metrics.inCall = inCall;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeoplePresence(result) {
    if (this.bookingIsActive) {
      if (this.o.logDetailed) console.debug(`Presence: ${result}`);
      const people = result === 'Yes';
      this.metrics.peoplePresence = people;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePeopleCount(result) {
    if (this.bookingIsActive) {
      if (this.o.logDetailed) console.debug(`People count: ${result}`);
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
      if (this.o.logDetailed) console.debug(`Sound level: ${result}`);
      const level = Number(result);
      this.metrics.presenceSound = level > this.o.soundLevel;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handlePresentationLocalInstance(result) {
    if (this.bookingIsActive) {
      if (result.ghost && result.ghost === 'True') {
        if (this.o.logDetailed) console.debug('Presentation stopped');
        this.metrics.sharing = false;
      } else {
        if (this.o.logDetailed) console.debug(`Presentation started: ${result.id}`);
        this.metrics.sharing = true;
      }

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }

  handleInteraction() {
    if (this.bookingIsActive && this.o.detectInteraction) {
      if (this.o.logDetailed) console.debug('UI interaction detected');

      this.lastFullTimestamp = Date.now();
      this.lastEmptyTimestamp = 0;

      if (this.listenerShouldCheck) {
        this.processOccupancy();
      }
    }
  }
}

// Init function
async function init() {
  // Declare Class
  const rr = new RoomRelease();
  // clear any lingering alerts
  rr.clearAlerts();
  // ensure codec is configured correctly
  await rr.configureCodec();
  // check for current meeting
  const currentId = await xapi.status.get('Bookings.Current.Id');
  if (currentId) {
    rr.processBooking(currentId);
  }

  console.info('--- Processing Room Resource Subscriptions');
  // Process booking start
  xapi.event.on('Bookings.Start', (event) => {
    console.log(`Booking ${event.Id} detected`);
    rr.processBooking(event.Id);
  });
  // Process booking extension
  xapi.event.on('Bookings.ExtensionRequested', (event) => {
    console.log(`Booking ${event.OriginalMeetingId} updated.`);
    rr.handleBookingExtension(event.OriginalMeetingId);
  });
  // Process booking end
  xapi.event.on('Bookings.End', (event) => {
    console.log(`Booking ${event.Id} ended Stop Checking`);
    rr.handleBookingEnd();
  });
  // Process UI interaction
  xapi.event.on('UserInterface.Extensions', () => {
    rr.handleInteraction();
  });
  // Handle message prompt response
  xapi.event.on('UserInterface.Message.Prompt.Response', (event) => {
    rr.handlePromptResponse(event);
  });
  // Process active call
  xapi.status.on('SystemUnit.State.NumberOfActiveCalls', (result) => {
    rr.handleActiveCall(result);
  });
  // Process presence detection
  xapi.status.on('RoomAnalytics.PeoplePresence', (result) => {
    rr.handlePeoplePresence(result);
  });
  // Process presentation detection
  xapi.status.on('Conference.Presentation.LocalInstance[*]', (result) => {
    rr.handlePresentationLocalInstance(result);
  });
  // Process people count
  xapi.status.on('RoomAnalytics.PeopleCount.Current', (result) => {
    rr.handlePeopleCount(result);
  });
  // Process sound level
  xapi.status.on('RoomAnalytics.Sound.Level.A', (result) => {
    rr.handleSoundDetection(result);
  });
}

init();
