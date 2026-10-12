# Tandem — Claude Usage

A small Windows app that lives next to your clock and shows how much of your Claude limits each of your
accounts has used. When one account runs out in the middle of a Claude Code chat, Tandem helps you carry that
chat over to another.

> **Unofficial.** Tandem is not affiliated with, endorsed by or supported by Anthropic. It reads your own usage
> from claude.ai the way the website shows it to you, and may stop working if the site changes.

<p align="center">
  <img src="docs/accounts.png" width="360" alt="An account as a block of tiles: its session and weekly limits, the trend and the other account">
  <img src="docs/sessions.png" width="360" alt="The chats used in the last day, each with the size of its context">
</p>

## What it does

- **Every account at a glance.** One block of tiles per account: the 5-hour session and the weekly limit as
  big numbers, any extra usage, when each resets, and where each is heading at your current pace. Each goes
  from green to blue, orange and red as it is used up.
- **Knows which account is in use.** It finds the account your Claude apps are on right now and shows it in
  two small icons next to the clock: one for the session, one for the week.
- **Warns you in time.** Notifications at two thresholds you choose, when the account in use is about to run
  out (and which other account has room), and when a chat has grown past the size you set.
- **Active sessions.** The Claude Code chats you used in the last 24 hours, each with the size of its context,
  whether its prompt cache is still warm, what a message costs, its model and effort, how many connectors it
  loads and how many images it carries.
- **Handoff prompts.** One click writes a prompt that sums a chat up (its folder, what you asked, your last
  messages, the files in play) so you can continue it in a new chat with another account. No model is called.
- **Tips.** A view with what you could do right now to spend fewer tokens, taken from your own chats, plus
  eight habits that pay off and how to apply each.
- **Graphify, optionally.** If you have the `graphify` command-line tool installed, Tandem can turn its
  knowledge graph on or off for a chat's project.
- A guided tour for new users, English and Spanish, five themes, and an optional glass effect.

## Install

1. Download `Tandem.Setup.x.y.z.exe` from the [latest release](../../releases/latest).
2. Run it. The installer is not code-signed, so Windows SmartScreen will warn you: choose **More info → Run
   anyway**.
3. Tandem opens next to the clock. Add an account in Settings and sign in to claude.ai in the window that opens.

Requires Windows 10 or 11 (64-bit). The glass effect needs Windows 11 22H2 or later.

Updating is running the newer installer over the old one; accounts, sign-ins and settings are kept.

## Privacy

- **Your password never reaches Tandem.** You sign in on claude.ai itself, in a browser window of the app.
  Each account gets its own isolated session, stored in Tandem's data folder like a browser profile.
- **It only talks to claude.ai.** There is no server of its own, no analytics and no telemetry.
- **Everything else is read locally and stays there.** To list your chats, Tandem reads the Claude Code
  transcripts in `~/.claude/projects` and the session list of the Claude desktop app.
- **Handoff prompts are saved as plain text.** They hold excerpts of your chat (what you asked, your last
  messages, file names) and are kept for seven days in `prompts.json`, in Tandem's data folder. One is
  written without your asking when a chat grows past the size you set, so it is ready when you are warned.
- **How it reads your usage.** It asks claude.ai for the same figures the website shows you, using the
  sign-in you gave it, through pages that are not a documented API. To be let in by sign-in providers it
  presents itself as a normal browser rather than as an Electron app.
- Tandem's data lives in `%APPDATA%\Tandem`: settings, the sign-ins and the saved prompts. Uninstalling
  leaves that folder in place, so an update never loses your accounts; delete it yourself to remove them.
- It starts with Windows by default. You can turn that off in Settings.

## Build it yourself

```bash
npm install
npm start        # run from source
npm run dist     # build the installer into dist/
```

The tests are plain Node scripts:

```bash
node tools/store-test.js
node tools/handoff-test.js
node tools/claude-app-test.js
node tools/images-test.js
node tools/graphify-test.js
```

## How it is built

Electron, with no framework in the interface.

| | |
|---|---|
| `src/main.js` | windows, tray, accounts, polling, notifications |
| `src/renderer/` | the interface: `app.js`, `style.css`, `index.html` |
| `src/handoff.js` | reads Claude Code transcripts and writes the handoff prompts |
| `src/insights.js` | token statistics and usage history |
| `src/claude-app.js` | reads the Claude desktop app's session list |
| `src/images.js` | counts the images inside a transcript, in the background |
| `src/graphify.js` | runs the graphify command-line tool |
| `src/store.js` | JSON files written atomically, with a backup |
| `src/i18n.js` | English and Spanish texts |

The typeface is [Outfit](https://github.com/Outfitio/Outfit-Fonts), under the SIL Open Font License
(`src/renderer/fonts/Outfit-OFL.txt`).

## License

[MIT](LICENSE) © Abraham Agüero
