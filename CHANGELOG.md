# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-06-19

### Added
- `/start` command with welcome message and quick setup guide
- Token format validation (`^\d+:[\w-]+$`) before connecting
- Auto-reconnect with exponential backoff (5s -> 10s -> 20s -> 30s cap)
- LRU-bounded session tracking (max 100 entries)
- Pending message timeout (30s) to prevent memory leaks
- Non-text message handler (replies "Only text messages are supported.")
- Prefix ambiguity detection ("Multiple sessions match. Use the full ID.")
- Graceful shutdown in `dispose()` (clears all timers, maps, and state)

### Changed
- Removed all emoji characters from user-facing messages
- `findSessionById` now returns typed result (`found | ambiguous | not_found`)
- `lastForwardedBySession` uses LRU eviction instead of unbounded growth
- `pendingTelegram` entries auto-expire after 30s
- Error messages are shorter and more consistent

### Fixed
- Bot never auto-reconnected after 403/block errors
- `lastForwardedBySession` grew unbounded with every new session
- `pendingTelegram` leaked entries when `prompt()` hung
- Prefix matching silently failed when multiple sessions matched
- `dispose()` didn't clean up timers or pending state

## [1.9.2] - 2026-06-19

### Changed
- All error messages prefixed with error indicators
- `sanitizeUI()` strips stack traces and truncates to 200 chars
- `fmtId()` truncates session IDs to 12 chars

### Fixed
- `userError()` now extracts only the first line of error messages
- All `ctx.reply()` error paths go through `sanitizeUI()`

## [1.9.1] - 2026-06-19

### Added
- Prefix matching for session IDs in `/link` and `/use`
- `/ls` now shows full session IDs for easy copy-paste

### Fixed
- `/link` used `client.session.get()` which failed for valid IDs from other directories
- Now uses `client.session.list()` + `findSessionById()` for reliable matching

## [1.9.0] - 2026-06-19

### Added
- `handlePluginError()` maps known errors to friendly messages
- `debugLog()` for structured debug output (enable with `DEBUG_TELEGRAM=1`)
- All bot command handlers wrapped in try/catch

### Fixed
- Raw error objects could overflow the TUI with stack traces
- `String(err)` on SDK errors produced 500+ line dumps
- Event handler errors not sanitized

## [1.8.1] - 2026-06-19

### Changed
- `/ls` output shows both session title and ID

## [1.8.0] - 2026-06-19

### Added
- `slashName: "telegram"` on TUI palette command
- `/telegram` now appears in chat slash suggestions
- `desc` field on palette command for meaningful descriptions

### Fixed
- Removed all 6 `console.log` startup statements
- All `bot.stop()` calls wrapped in try/catch
- All `client.session.*` SDK calls wrapped in try/catch
- Added `bot.catch()` for global Telegraf error handling

## [1.7.0] - 2026-06-18

### Added
- TUI plugin with `/telegram` slash command for token setup
- Dialog prompt for pasting bot token
- Toast notification on successful token save

### Fixed
- Cleared stale OpenCode cache for plugin updates

## [1.0.0] - 2026-06-13

### Added
- Initial release
- Bidirectional Telegram <-> OpenCode bridge
- Session linking via `/link`
- `/ls`, `/use`, `/history`, `/help` commands
- `telegram_send` tool for LLM-initiated messages
- Persistent links across restarts
- Multi-session support
- `allowed_users` access control
- `notify_on_reconnect` option
