# GeoFS Defensive AI

Tampermonkey userscript for GeoFS military RP. It is a combat state engine that follows the lock -> fire -> countermeasure -> hit/miss sequence.

## Install
Install Tampermonkey, then open `geofs-defensive-ai.user.js` (raw) and confirm the install.

## Rules followed
- `lock/locking <weapon> on <callsign>` creates a pending threat (LOCKED). No response is sent.
- `away` / `firing` / `fox N away` launches it (LAUNCHED) and starts a 5 s countermeasure window.
- IR weapons -> flares, radar weapons -> chaffs, mixed families use one single countermeasure (default flares) only when the family is truly ambiguous; explicit seeker variants are resolved individually (for example `r27er` -> `chaffs`, `r27et` -> `flares`), guns/Fox 4 -> evade (guns are immediate).
- States: LOCKED, LAUNCHED, COUNTERED, HIT, MISSED, EXPIRED. Locks expire after 30 s.
- Targets are matched by alias (A1, Alpha-1, Alpha One, ...). Threats aimed at others are ignored.
- One auto reply per threat. Chat buffer: 50 messages / 60 s.

## Known gaps
- HUD, audio and live chat are untested in a real GeoFS session.
- GeoFS sender field names are unverified.
- A bare "away" with no prior lock is ignored.

## missiledb/
Air-to-air missile alias database (100 missiles, 4,697 aliases) with FOX type and countermeasure lookups. From the repository root, regenerate the JSON files with `python missiledb/build.py`, then update the embedded userscript lookup with `node missiledb/embed.cjs`. Commit the generated userscript along with database changes.
## v4.0
- Automatic identity detection (callsign, username, display name) with live callsign-change tracking
- Setup wizard fallback, Alt+D settings panel, debug panel
- Persistent settings and cooldowns via localStorage

## v4.2
- Fixed chat monitor initialization and switched automatic replies to GeoFS's native `multiplayer.setChatMessage` API.
- Failed sends show a warning instead of marking a threat as countered; the debug panel includes the latest send status.
- Expanded the built-in detector to 88 missile-family/variant entries with designations, common names, NATO names, and spelling variants.
- Explicit IR variants use `flares`, radar variants use `chaffs`, mixed/unspecified families default to `flares`, and beam/passive guidance uses `evading` for roleplay.
- This version's built-in detector was separate from the generated `missiledb/` data; v4.3 connects the full database.
- Live delivery and countermeasure effectiveness are not guaranteed.

## Tests
Run `node --test counteruser.test.js` with Node.js to check the regression tests, including representative shorthand lock parsing and database alias coverage.
Run `node missiledb/embed.cjs --check` to verify the embedded lookup is up to date.

## v4.3
- Embeds all 100 database records and their aliases directly in the installable userscript; no GitHub fetch or extra userscript permissions are needed.
- Uses longest whole-word alias matching so specific nicknames such as `Chinese AMRAAM` and variants such as `Astra IR` take precedence over generic family names.
- Retains the built-in seeker-specific corrections, including AIM-9C and R-27ET. Conflicting database guidance for a shared alias is treated as mixed unless an explicit variant or FOX call resolves it.
- Includes the supplied database's experimental designations and community nicknames as roleplay inputs, not as verified claims about real weapons.

## v4.4
- Detects account names from nested account/profile records and the GeoFS account button, excluding icon text and other players' labels. Refreshes identity before processing chat; multi-word account aliases are supported.
- All database aliases are case-insensitive: `aa3`, `AA3`, `aa-3`, and `aa 3` are recognized. AA-3 does not specify its seeker, so it defaults to `flares`; add `fox 1` or `fox 2` to specify radar or IR guidance.
- Observes native published chat as well as network updates, including when GeoFS loads after the addon. Uses GeoFS sender account/session IDs for own-message detection and timestamps to distinguish repeated calls.
- Pending automatic replies wait for cooldowns or a busy native chat slot and retry within the threat's five-second countermeasure window. They are dropped on expiry or when automatic replies are disabled, and never overwrite another queued chat message.
- The debug panel shows identity sources, send status, and pending reply count. A queued reply still does not guarantee server delivery.
- When using a standalone copy such as `counteruser.js`, replace it with the current `geofs-defensive-ai.user.js` contents; older copies do not receive database updates automatically. Enable only one copy of the addon.

## v4.5
- Accepts weapon-first locks (`aa12 locked on T9`), target-first locks (`lock on T9 with aa3`), `onto` targets, and `fire`, `shoot`, or `launching` launch calls. Combined lock-and-launch calls ending in `away` or a launch verb now launch the recorded threat in the same message.
- Checks explicit GeoFS chat, login, and multiplayer readiness flags before queuing a reply. Native API rejection is surfaced rather than reported as a successful countermeasure.
- Alt+D shows current chat blockers and includes **Send test chat: flares**. This button posts a real chat message when clicked; it does not simulate an incoming attack.
- The debug panel explains ignored messages (unmatched target, unrecognized missile, no prior lock, duplicate, or own message). Testing your own attack calls will not trigger automatic defense; have a different player send them.
- Known sender IDs take precedence over matching callsigns, so another player using the same callsign is not mistaken for the local account.
- Native chat publication is the primary incoming source when available; network capture remains the fallback. Repeated fresh calls without message IDs/timestamps are no longer permanently discarded, and network copies of published messages are ignored.
- Tests now exercise every database designation/alias through the full lock -> launch -> native outgoing chat path, not just parsing. Server delivery remains dependent on GeoFS and is not confirmed by the local queue.

## v4.6
- Gun attacks now reply exactly `evade`: `fox4 <name>`, `fox 4 <name>`, `guns <name>`, `guns guns guns <name>`, and `gun <name>`. Existing `on`/`at` target forms remain supported; bare FOX-4 calls require a prior lock from that sender.
- IR missiles still reply `flares`, radar missiles reply `chaffs`, and mixed/unspecified families default to `flares` unless a seeker-specific FOX call or explicit guidance resolves otherwise. Beam/passive guidance retains `evading`.
- Defense maintenance, identity refresh, and queued-reply retries tick every 1,000 ms. Incoming attacks are still processed immediately; this does not change the reply cooldown or five-second countermeasure window.
- Both `evade` and legacy `evading` are accepted as manually posted evasion countermeasures.

## v4.7: connection safety
- Removed all fetch/XHR interception. Detection observes native `ui.chat.publish` only; it waits for that API to load rather than inspecting MPS network responses.
- Each native chat object is hooked at most once, even if another addon wraps the same method. Duplicate execution of this version exits when an existing Defensive AI instance is present.
- The one-second tick is local maintenance only: it does not send MPS requests, reconnect multiplayer, or change GeoFS update timing. Countermeasure messages use the normal GeoFS chat queue and existing reply cooldown.
- After installing this version, close old GeoFS tabs and disable duplicate/older Defensive AI copies before loading a single tab. A reload is required to discard wrappers installed by old versions. If MPS returns HTTP 429, stop repeated reloads and allow the server rate limit to clear; this addon cannot reset it.

## v4.8
- Removed the inaccurate "GeoFS multiplayer is not running" chat blocker. `multiplayer.on` and `multiplayer.started` no longer prevent replies when the native chat API is available.
- Explicit disabled-chat and signed-out checks remain, along with busy-queue, cooldown, and API rejection handling. The addon does not change multiplayer lifecycle flags or force a connection.

## v5.1
- Shorthand lock parsing now prefers real missile aliases before the target token, so representative calls like `lock aim9 t9`, `lock r27et t9`, `lock mica ir t9`, and `lock aa3 t9` resolve correctly instead of swallowing the target.
- The addon's current installable script version is 5.1.
