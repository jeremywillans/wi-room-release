# Changelog

## 0.1.0
- MTR Support
- MS Teams notification support

## 0.0.9
- Reset countdown variable after meeting decline
- Reduce default interval timer to 1 minute
- Prevent duplicate delete timeouts

## 0.0.8
- Fix errors with output to Webex Messaging

## 0.0.7
**BREAKING** - Requires Manifest update for Workspace Integration
- Add ability to send Webex Message when room released

## 0.0.6
- Prevent duplicate check interval loops and countdown timers
- Catch failure for retrieving booking id

## 0.0.5
- Fix ongoing loop during release timeout

## 0.0.4
- Bump WI Package for retry support

## 0.0.3
- Fix error handling for non-async xapi commands
- Reduce non-essential xapi requests on presence change 
- Include docker compose file and instructions
- Include room release process flow
- Bump deps

## 0.0.2
- Remove ultrasound parameters - glass wall scenarios can be remedied using meeting zones
- Consolidate getMetrics xAPI requests

## 0.0.1
- Reset version to 0.0.1
- Added Changelog and embed version display on load
- Add winston-syslog as external logging server option
- Update detailed logging, always show error log messages to debug