# Changelog

What changes in each version of Tandem that someone using it would notice, newest first. Small visual
touch-ups are left out unless they change how something is used. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/abrahamaguero/tandem-claude-usage/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/abrahamaguero/tandem-claude-usage/releases/tag/v0.4.0
