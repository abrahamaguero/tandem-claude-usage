# Changelog

What changes in each version of Tandem that someone using it would notice, newest first. Small visual
touch-ups are left out unless they change how something is used. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet.

## [0.8.0] - 2026-11-11

### Added

- A version for macOS. Tandem lives in the menu bar, and its panel and alerts hang under its icons. It is not
  signed with an Apple certificate yet: macOS asks to allow it once.

## [0.7.1] - 2026-11-11

### Added

- The plan of each account (Pro, Max, Ultra, Team…) next to its name.

### Changed

- A personal account shows its email instead of the "…'s Organization" name claude.ai gives it.

## [0.7.0] - 2026-11-11

### Changed

- Tandem follows the new way claude.ai reports limits. An account with no 5-hour limit (a verified Ultra
  one) shows "no limit" where the session was, a dotted ring and a single icon by the clock, instead of
  the weekly figure twice.

### Added

- Limits of the week for one model, such as Fable's, with how much of the week it may take.
- Where the week went: the share of Claude Code, chats and Cowork, when claude.ai reports it.
- Extra usage that is turned off says so.
- An alert when the week of the account in use will not last until it resets at its pace so far: when it
  would run out, and how much a day would still make it. Once a week, and only once the week is a day old.

## [0.6.2] - 2026-10-18

### Added

- A line on top of the sign-in window: you sign in once per account and it lasts for weeks, Google, Apple
  or a code by email work without a saved password, and why Tandem cannot use the sign-in of your browser.

## [0.6.1] - 2026-10-18

### Fixed

- The ✕ of an alert, and pressing the alert to open Tandem, did nothing: Windows was not passing the
  press of the mouse to it.

## [0.6.0] - 2026-10-12

### Added

- Tandem's own alerts: a small bubble right above its icons in the taskbar, with a drawing of what the
  alert is about and the limits, or the size of the chat, as bars. Pressing it opens Tandem. The
  notifications of Windows remain as an option in Settings, where a button shows a sample alert.

## [0.5.1] - 2026-10-12

### Changed

- Limits are colored by quarters: green up to 25%, blue up to 50%, orange up to 75% and red from there on,
  in the icons next to the clock, the bars and the chips. The colors no longer follow the thresholds set
  for the notifications; those still decide when Tandem warns you.

## [0.5.0] - 2026-10-12

### Added

- Four more languages: Brazilian Portuguese, French, German and Japanese. A new install starts in the
  language of the system.
- A notice in the app, and a notification, when a newer version is out. Tandem asks GitHub twice a day for
  the number of the latest version; it can be turned off in Settings.
- A button at the bottom of Settings to send feedback.

### Changed

- Limits are shown in four colors instead of three: green, blue, orange and red.

## [0.4.0] - 2026-10-12

First public release.

[Unreleased]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/abrahamaguero/tandem-claude-usage/releases/tag/v0.4.0
