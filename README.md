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
Air-to-air missile alias database (100 missiles, ~4,700 aliases) with FOX type and countermeasure lookups. Regenerate with `python build.py`.
## v4.0
- Automatic identity detection (callsign, username, display name) with live callsign-change tracking
- Setup wizard fallback, Alt+D settings panel, debug panel
- Persistent settings and cooldowns via localStorage

