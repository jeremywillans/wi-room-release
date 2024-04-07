# wi-room-release

## Room Release Workspace Integration

![RoomOS-Yes](https://img.shields.io/badge/RoomOS-Integration%20&%20Macro-green.svg?style=for-the-badge&logo=cisco) ![MTR-Warning](https://img.shields.io/badge/MTR-Requires%20RoomOS%2011.14+-yellow.svg?style=for-the-badge&logo=microsoftteams)

Room Release is a Workspace Integration designed to automatically release a room booking based on occupancy metrics from the Cisco codec.

This has been refactored from a per-device macro to instead run from a central location, ideally as a docker container, and leverages the Webex cloud xAPIs to manage and subscribe to events for your devices.

This solution now leverages the new consolidated 'RoomInUse' metric which automatically determines if a room is being used based on available sources, statuses and events.

If desired, the following individual metrics can be used for this calculation
- People Presence
- Sound Levels
- Active Call
- Presentation Sharing
- UI Interaction

If the room is unable to detect presence this integration will wait 5 minutes before declaring the room unoccupied, and will present a dialog to initiate a Check In.
This prompt, along with playing an announcement tone, will display for 60 seconds before the booking will be declined and removed from the device.

Note: there is new a new parameter (`initialReleaseDelay`) allowing you to define an initial delay (from booking start) before invoking the countdown and releasing the room.

Additionally, there is built in functionality to ignore the release of larger bookings (duration adjustable), such as all day events which may not start on time.

Periodic check of devices occurs every 30 minutes (on the half/hour intervals) to detect if a new device is un/tagged, otherwise devices are re/processed on integration restart.

The process flow for how this works is included below.

**0.2 Updates** 
Ghosted meetings are now checked when a meeting commences and the status included for Webex and MS Teams outputs. 

You can now optionally choose to decline a Meeting Series if multiple ghost booking occur (default `3`). This uses the Microsoft Graph API to decline the Series. A local json file is stored with container (default `/config/graph.json`, recommend attach as a volume) which tracks devices and Series which have had a ghost booking.

## Macro Version
Within the macro directory of this repository contains a macro version of this for individual device deployment, if preferred. As the underlying code is shared between both the macro and the Workspace Integration, it will be maintained in the same repository for consistency.

## Prerequisites

The following items are needed, depending on the enabled services.

### MTR Device Mode
This solution requires Control Hub registration to a workspace with the Calendar Service activated.

By default, when a device is in MTR mode, calendaring is disabled - you either need to add the calendar **before** adding the MTR Device, or alternatively (and recommended) add an additional Navigator in Standalone mode, to the same workspace which will enable the calendar service.

### Workspace Integration
1. Navigate to Workspace Integrations in [Control Hub](https://admin.webex.com/workspaces/integrations)
2. Select `Add integration` then `Upload integration` and provide included manifest.json file - ensure you document the provided credentials
3. Navigate to the newly created Integration and select `Activate` from the `Actions` menu - ensure you document the encoded activation code
4. Add the required Device Tag (default: `wi-room-release`) to each device to be managed by this integration

### Webex Space
- A Webex Bot - create at [developer.webex.com](https://developer.webex.com/my-apps/new/bot) 
- A new or existing Webex Space with the Webex bot as a member.
- The RoomId of the destination Webex space. These example methods can be used to get the Room Id
  - Using the [List Rooms](https://developer.webex.com/docs/api/v1/rooms/list-rooms) Developer API
  - Adding `astronaut@webex.bot` to the space (bot will leave and 1:1 you the Id)

### MS Teams Channel
- A MS Teams 'Team' Channel configured with an [Incoming Webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook?#create-an-incoming-webhook)
- Copy the Webhook URL

### MS Graph - Series Decline
- Microsoft Entra Tenant Id
- Create a new App Registration in Microsoft Entra
  - Type: `Accounts in any organizational directory (Any Azure AD directory - Multitenant)`
  - Redirect URI: Web Platform, `https://login.microsoftonline.com/common/oauth2/nativeclient`
  - Client ID: Copy from Overview Page
  - Client Secret: Generate from Certificates & secrets section - TAKE NOTE OF LIFETIME!
  - API Permissions: Graph API: Application Permissions: `Calendars.ReadWrite`
  - Admin needs to Grant Permission

## Deployment (Local)

1. Clone / Download repository
2. Run `npm install` to add the require dependencies (ensure Node and NPM are installed)
3. Create an `.env` file and include the required variables outlined below.
- Recommend adding `WI_LOGGING=info`, `CONSOLE_LEVEL=debug`, `LOG_DETAILED=true` and `RR_TEST_MODE=true` during initial testing
4. (Optional) Create a directory called `config` which is used to store a listing of device instances for series decline, if enabling the MS Graph option.
4. Start the integration using `npm run start`
5. Review the console logs to confirm no errors encountered

## Deployment (Docker)

The simplest deployment method is using [Docker](https://docs.docker.com/engine/install/) and [Docker Compose](https://docs.docker.com/compose/install/)

1. Clone / Download repository
   - Only sample.env and docker-compose.yml are needed if using prebuilt docker image
2. Rename `sample.env` to `.env` file and update the environment variables outlined below.
3. - Use the prebuilt image available on Docker Hub (included in docker-compose.yml)
   - Build the Docker Image using `docker build --tag wi-room-release .` and update image line in docker-compose.yml
4. Provision and start the Integration using `docker-compose up -d`
5. Review the console logs using `docker logs wi-room-release -f` (assuming you are using the default container name)

### Environmental Variables

These variables can be individually defined in Docker, or loaded as an `.env` file in the app directory.

| Name | Required | Type | Default | Description
| ---- | ---- | ---- | ------- | -----------
| **Integration Settings**
| CLIENT_ID | **Yes** | string | ` ` | Client Identifier provided during the Integration creation process
| CLIENT_SECRET | **Yes** | string | ` ` | Client Secret provided during the Integration creation process
| **---**
| CODE | no* | string | ` ` | Encoded Activation Code provided during the Integration activation process
| *-- or --*
| OAUTH_URL | no* | string | ` ` | Decoded oAuth URL from the Activation Code
| REFRESH_TOKEN | no* | string | ` ` | Decoded Refresh Token from the Activation Code
| WEBEXAPIS_BASE_URL | no* | string | ` ` | Decoded Webex APIs Base Url from the Activation Code
| APP_URL | no* | ` ` | string | Decoded App Url from the Activation Code
| **---**
| DEVICE_TAG | no | string | `wi-room-release` | Device Tag used to determine which devices to process
| **Logging Settings**
| LOG_DETAILED | no | bool | `true` | Enable detailed logging
| CONSOLE_LEVEL | no | bool | `info` | Logging level exposed to console
| APP_NAME | no | string | `wi-room-release` | App Name used for logging service
| SYSLOG_ENABLED | no | bool | `false` | Enable external syslog server
| SYSLOG_HOST | no | string | `syslog` | Destination host for syslog server
| SYSLOG_PORT | no | num | `514` | Destination port for syslog server
| SYSLOG_PROTOCOL | no | str | `udp4` | Destination protocol for syslog server
| SYSLOG_SOURCE | no | str | `localhost` | Host to indicate that log messages are coming from
| LOKI_ENABLED | no | bool | `false` | Enable external Loki logging server
| LOKI_HOST| no | string | `http://loki:3100` | Destination host for Loki logging server
| **HTTP Proxy**
| GLOBAL_AGENT_HTTP_PROXY | no | string | ` ` | Container HTTP Proxy Server (format `http://<ip or fqdn>:<port>`)
| GLOBAL_AGENT_NO_PROXY | no | string | ` ` | Comma Separated List of excluded proxy domains (Supports wildcards)
| NODE_EXTRA_CA_CERTS | no | string | ` ` | Include extra CA Cert bundle if required, (PEM format) ensure location is attached as a volume to the container
| **Occupancy Detections**
| RR_ROOM_IN_USE | yes | bool | `true` | Leverage new consolidated metric to determine occupancy status
| **Legacy Occupancy Detections**
| RR_USE_SOUND | no | bool | `false` | Use sound level to consider room occupied (set level below)
| RR_USE_ACTIVE_CALL | no | bool | `true` | Use active call for detection (inc airplay)
| RR_USE_INTERACTION | no | bool | `true` | UI extensions (panel, button, etc) to detect presence.
| RR_USE_PRESENTATION | no | bool | `true` | Use presentation sharing for detection
| RR_SOUND_LEVEL | no | num | `50` | (dB) Minimum sound level required to consider occupied
| **Disable Occupancy Checks**
| RR_BUTTON_STOP_CHECKS | no | bool | `false` | Stop further occupancy checks after check in
| RR_OCCUPIED_STOP_CHECKS | no | bool | `false` | Stop periodic checks if room considered occupied
| RR_CONSIDERED_OCCUPIED | no | num | `15` | (Mins) minimum duration until considered occupied
| **Thresholds and Timers**
| RR_EMPTY_BEFORE_RELEASE | no | num | `5` | (Mins) time empty until prompt for release
| RR_INITIAL_RELEASE_DELAY | no | num | `10` | (Mins) initial delay before prompt for release
| RR_IGNORE_LONGER_THAN | no | num | `3` | (Hrs) meetings longer than this will be skipped
| RR_PROMPT_DURATION | no | num | `60` | (Secs) display prompt time before room declines invite
| RR_PERIODIC_INTERVAL | no | num | `1` | (Mins) duration to perform periodic occupancy checks
| **Webex Notification Options**
| RR_WEBEX_ENABLED | no | bool | `false` | Send message to Webex space when room released
| RR_WEBEX_ROOM_ID | no | string | ` ` | Webex Messaging Space to send release notifications
| RR_WEBEX_BOT_TOKEN | no | string | ` ` | Token for Bot account - must be in Space listed above!
| **Teams Notification Options**
| RR_TEAMS_ENABLED | no | bool | `false` | Send message to MS Teams channel when room released
| RR_TEAMS_WEBHOOK | no | string | ` ` | URL for Teams Channel Incoming Webhook
| **Graph API Options**
| GRAPH_ENABLED | no | string | ` ` |  Track series ghost bookings, decline if exceeds strike threshold
| GRAPH_STRIKES | no | num | `3` | Number of ghost bookings before the series is declined
| GRAPH_TENANT | no | string | ` ` | Tenant ID from MS Entra app registration
| GRAPH_CLIENT_ID | no | string | ` ` | Client ID from MS Entra app registration
| GRAPH_CLIENT_SECRET | no | string | ` ` | Client Secret from MS Entra app registration
| GRAPH_JSON | no | str | `config/graph.json` | Location of graph store JSON file
| GRAPH_CALENDAR_YEARS | no | num | `3` | Number of years ahead to search for Series Exceptions
| **Other Parameters**
| RR_TEST_MODE | no | bool | `false` | Used for testing, prevents the booking from being removed
| RR_PlAY_ANNOUNCEMENT | no | bool | `true` | Play announcement tone during check in prompt
| RR_FEEDBACK_ID | no | string | `alertResponse` | Identifier assigned to prompt response
| RR_HTTP_TIMEOUT | no | num | `60000` | HTTP API Timeout, in milliseconds

***Note:** You must either include the encoded Activation Code, or the four individual decoded parameters.

## Room Release Process Flow
#### Init
- During macro initialization, the device is configured and an instance of the Room Release class is instantiated.
- Subscriptions are setup for the required events and statuses, with the results passed to the appropriate handler in the class
#### Booking Active
- Booking start time is reached or macro is restarted (and there is an active booking)
- The meeting is processed to determine duration, calculate the initial delay and is marked as active.
- If the meeting is longer than `ignoreLongerThan` duration, no further action is taken.
- Initial occupancy data is retrieved from the Codec and processed to determine current room status. 
- Ghost status by default is set to true for the booking.
- If occupancy is detected at booking start, a ghost delay is added to reset at 4 minutes or just before initialReleaseDelay (which ever is first) in an attempt to prevent the previous meeting occupants from invalidating the ghost option
- Based on occupied/empty status from the processing of metrics, the appropriate timestamp (last empty or full) is recorded to track room status
- Once a booking is marked active, the subscriptions for occupancy metrics are processed when there are changes detected (presence, sound, active call, etc.)
- When metrics changes are detected, the value for the affected metric is updated. If the metric is enabled, then the occupancy metrics are reprocessed.
- To ensure accurate occupancy and timestamps are kept, at the `periodicInterval`, new occupancy metrics are retrieved from the device and reprocessed.
- If any occupancy is detected in the room (after the ghost delay, if enabled) then the ghost option is set to false
#### Room Empty
- A room is considered empty if the current timestamp exceeds the last empty timestamp combined with the value of `emptyBeforeRelease`.
- Additionally, there `initialReleaseDelay` time needs to be met/exceeded. this is calculated from meeting start time.
- Next, A countdown will be displayed and a button displayed prompting a 'Check In' based on `promptDuration` length
- During the Check In prompt, a short announcement tone will also be played every 5 seconds if `playAnnouncement` is enabled (default true).
- If pressed, the room full timestamp will be updated with the current time, and checks will continue.
- If `buttonStopChecks` is enabled, checks will stop and no further action is taken.
- If the check in button is **not** pressed, and no occupancy changes are detected in the room, the booking will be declined and removed from the calendar.
- If the meeting is deemed ghosted (ghost option is still true) and the graph api option is enabled, then a check will be performed to determine if this meeting is part of a series. If it is, then it will be recorded a strike against the series master in the graph.json file.
- If the Graph API strike condition is met (default `3`), then the Graph API will be used to locate and decline individual series exceptions (default search based on `3` years), and then decline the whole series from the room calendar.
- We specifically decline the exceptions first to ensure the response is correctly updated to 'No' in the Organizers calendar.
#### Room Occupied
- A room is considered full if the current timestamp exceeds the last full timestamp combined with the value of `consideredOccupied`.
- Once a room is considered full and `occupiedStopChecks` is enabled (default `false`), checks will stop and no further action is taken.
- Occupancy metrics will be continually processed by either status changes in the room, or based on the `periodicInterval` timer.
- Once the booking ends, it will be marked inactive and checks will stop until the next meeting.

## Support

In case you've found a bug, please [open an issue on GitHub](../../issues).

## Disclaimer

This application is provided as a sample only is NOT guaranteed to be bug free and production quality.
