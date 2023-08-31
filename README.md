# wi-room-release

## Room Release Workspace Integration

Room Release is a Workspace Integration designed to automatically release a room booking based on occupancy metrics from the Cisco codec.

This has been refactored from a per-device macro to instead run from a central location, ideally as a docker container, and leverages the Webex cloud xAPIs to manage and subscribe to events for your devices.

The following metrics can be used for this calculation
- People Presence (Head Detection)
- Room Ultrasound
- Sound Levels
- Active Call
- Presentation Sharing
- UI Interaction

If the room is unable to detect presence this integration will wait 5 minutes before declaring the room unoccupied, and will present a dialog to initiate a Check In.
This prompt, along with playing an announcement tone, will display for 60 seconds before the booking will be declined and removed from the device.

Note: there is new a new parameter (`initialReleaseDelay`) allowing you to define an initial delay (from booking start) before invoking the countdown and releasing the room.

Additionally, there is built in functionality to ignore the release of larger bookings (duration adjustable), such as all day events which may not start on time.

Periodic check of devices occurs every 30 minutes to detect if a new device is un/tagged, otherwise devices are processed on integration restart.

## Prerequisites

1. Navigate to Workspace Integrations in [Control Hub](https://admin.webex.com/workspaces/integrations)
2. Select `Add integration` then `Upload integration` and provide included manifest.json file - ensure you document the provided credentials
3. Navigate to the newly created Integration and select `Activate` from the `Actions` menu - ensure you document the encoded activation code
3. Add the required Device Tag (default: `wi-room-release`) to each device to be managed by this integration

## Deployment (Local)

1. Clone / Download repository
2. Run `npm install` to add the require dependencies (ensure Node and NPM are installed)
3. Create an `.env` file and include the required variables outlined below.
- Recommend adding `WI_LOGGING=info`, `CONSOLE_LEVEL=debug`, `LOG_DETAILED=true` and `RR_TEST_MODE=true` during initial testing
4. Start the integration using `npm run start`
5. Review the console logs to confirm no errors encountered

## Deployment (Docker)

1. Build and Deploy Docker Container (or deploy to Cloud) - ensure you include the required variables outlined below.
An example [docker-compose.yml](docker-compsose.yml) file has been included to sp
- This integration does not require local device access as all communications are done over Cloud xAPI.

    ```
    > docker build --tag wi-room-release .
    > docker create --name wi-room-release \
      -e _ENVIRONMENTAL_VARIABLE_ = _value_ \
      wi-room-release
    ```

2. Review the logs from the Integration output to confirm no errors encountered

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
| **Occupancy Detections**
| RR_USE_SOUND | no | bool | `false` | Use sound level to consider room occupied (set level below)
| RR_USE_ULTRASOUND | no | bool | `false` | Use Ultrasound for presence detection
| RR_REQUIRE_ULTRASOUND | no | bool | `false` | Require Ultrasound detection (eg. glass walls)
| RR_USE_ACTIVE_CALL | no | bool | `true` | Use active call for detection (inc airplay)
| RR_USE_INTERACTION | no | bool | `true` | UI extensions (panel, button, etc) to detect presence.
| RR_USE_PRESENTATION | no | bool | `true` | Use presentation sharing for detection
| **Disable Occupancy Checks**
| RR_BUTTON_STOP_CHECKS | no | bool | `false` | Stop further occupancy checks after check in
| RR_OCCUPIED_STOP_CHECKS | no | bool | `false` | Stop periodic checks if room considered occupied
| RR_CONSIDERED_OCCUPIED | no | num | `15` | (Mins) minimum duration until considered occupied
| **Thresholds and Timers**
| RR_EMPTY_BEFORE_RELEASE | no | num | `5` | (Mins) time empty until prompt for release
| RR_INITIAL_RELEASE_DELAY | no | num | `10` | (Mins) initial delay before prompt for release
| RR_SOUND_LEVEL | no | num | `50` | (dB) Minimum sound level required to consider occupied
| RR_IGNORE_LONGER_THAN | no | num | `3` | (Hrs) meetings longer than this will be skipped
| RR_PROMPT_DURATION | no | num | `60` | (Secs) display prompt time before room declines invite
| RR_PERIODIC_INTERVAL | no | num | `2` | (Mins) duration to perform periodic occupancy checks
| **Other Parameters**
| RR_TEST_MODE | no | bool | `false` | Used for testing, prevents the booking from being removed
| RR_PlAY_ANNOUNCEMENT | no | bool | `true` | Play announcement tone during check in prompt
| RR_FEEDBACK_ID | no | string | `alertResponse` | Identifier assigned to prompt response

***Note:** You must either include the encoded Activation Code, or the four individual decoded parameters.

## Support

In case you've found a bug, please [open an issue on GitHub](../../issues).

## Disclaimer

This application is provided as a sample only is NOT guaranteed to be bug free and production quality.
