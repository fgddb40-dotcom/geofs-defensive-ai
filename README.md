# GeoFS Defensive AI

Tampermonkey userscript for GeoFS military RP. It is a combat state engine that follows the lock -> fire -> countermeasure -> hit/miss sequence.

## Install
Install Tampermonkey, then open `geofs-defensive-ai.user.js` (raw) and confirm the install.

## Rules followed
- `lock/locking <weapon> on <callsign>` creates a pending threat (LOCKED). No response is sent.
- `away` / `firing` / `fox N away` launches it (LAUNCHED) and starts a 5 s countermeasure window.
- IR weapons -> flares, radar weapons -> chaffs, guns/Fox 4 -> evading (guns are immediate).
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
- Explicit IR variants use `flares`, radar variants use `chaffs`, unspecified IR/radar families use `flares chaffs`, and beam/passive guidance uses `evading` for roleplay.
- This version's built-in detector was separate from the generated `missiledb/` data; v4.3 connects the full database.
- Live delivery and countermeasure effectiveness are not guaranteed.

## Tests
Run `node --test counteruser.test.js` with Node.js to check the regression tests, including recognition of every database alias.
Run `node missiledb/embed.cjs --check` to verify the embedded lookup is up to date.

## v4.3
- Embeds all 100 database records and their aliases directly in the installable userscript; no GitHub fetch or extra userscript permissions are needed.
- Uses longest whole-word alias matching so specific nicknames such as `Chinese AMRAAM` and variants such as `Astra IR` take precedence over generic family names.
- Retains the built-in seeker-specific corrections, including AIM-9C and R-27ET. Conflicting database guidance for a shared alias is treated as mixed unless an explicit variant or FOX call resolves it.
- Includes the supplied database's experimental designations and community nicknames as roleplay inputs, not as verified claims about real weapons.

## v4.4
- Detects account names from nested account/profile records and the GeoFS account button, excluding icon text and other players' labels. Refreshes identity before processing chat; multi-word account aliases are supported.
- All database aliases are case-insensitive: `aa3`, `AA3`, `aa-3`, and `aa 3` are recognized. AA-3 does not specify its seeker, so it uses `flares chaffs`; add `fox 1` or `fox 2` to specify radar or IR guidance.
- Observes native published chat as well as network updates, including when GeoFS loads after the addon. Uses GeoFS sender account/session IDs for own-message detection and timestamps to distinguish repeated calls.
- Pending automatic replies wait for cooldowns or a busy native chat slot and retry within the threat's five-second countermeasure window. They are dropped on expiry or when automatic replies are disabled, and never overwrite another queued chat message.
- The debug panel shows identity sources, send status, and pending reply count. A queued reply still does not guarantee server delivery.
- When using a standalone copy such as `counteruser.js`, replace it with the current `geofs-defensive-ai.user.js` contents; older copies do not receive database updates automatically. Enable only one copy of the addon.
