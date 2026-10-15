// ==UserScript==
// @name         GeoFS Defensive AI
// @namespace    GeoFS
// @version      3.0
// @description  Combat state engine: lock -> fire -> countermeasure -> hit/miss, per-attacker engagements, 5s defense timer
// @match        https://www.geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---------- helpers ----------
    const NUM_WORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };

    function normalize(s) {
        let t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        t = t.split(' ').map(w => NUM_WORDS[w] || w).join(' ');
        return t.replace(/\s+/g, ' ');
    }
    // Canonical callsign form: "Alpha One" / "alpha-1" / "Alpha1" / "A1" -> "a1"
    function canon(s) {
        return normalize(s).replace(/\balpha\b|\balfa\b/g, 'a').replace(/\s+/g, '');
    }

    // ---------- SettingsManager ----------
    class SettingsManager {
        static get KEY() { return 'geofs_defense_ai_v3'; }
        static get DEFAULTS() {
            return {
                enabled: true,
                aliases: ['A1', 'Riley', 'Belgium', 'Belgian Empire', 'Alpha One', 'Alpha1'],
                autoChat: true, hud: true, audio: false, debug: false,
                windowMs: 60000, windowSize: 50, lockLifeMs: 30000, counterWindowMs: 5000
            };
        }
        constructor() {
            this.data = Object.assign({}, SettingsManager.DEFAULTS);
            this.listeners = [];
            try {
                const raw = window.localStorage && window.localStorage.getItem(SettingsManager.KEY);
                if (raw) Object.assign(this.data, JSON.parse(raw));
            } catch (e) { /* ignore */ }
        }
        get(k) { return this.data[k]; }
        set(k, v) {
            this.data[k] = v;
            try { window.localStorage && window.localStorage.setItem(SettingsManager.KEY, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
            this.listeners.forEach(f => { try { f(k, v); } catch (e) { /* ignore */ } });
        }
        onChange(f) { this.listeners.push(f); }
    }

    // ---------- AliasManager ----------
    class AliasManager {
        constructor(list) { this.set(list || []); }
        set(list) {
            this.list = list.filter(Boolean);
            this.canons = new Set(this.list.map(canon).filter(Boolean));
        }
        add(name) { if (name) this.set(this.list.concat([name])); }
        // Is the text after "on" the user? Exact canonical match on first 1-3 words.
        isUser(text) {
            const words = normalize(text).split(' ').filter(Boolean);
            for (let n = Math.min(3, words.length); n >= 1; n--) {
                if (this.canons.has(canon(words.slice(0, n).join(' ')))) return true;
            }
            return false;
        }
    }

    // ---------- MessageBuffer ----------
    class MessageBuffer {
        constructor(size, windowMs) { this.size = size; this.windowMs = windowMs; this.items = []; }
        add(msg) {
            this.items.push(msg);
            if (this.items.length > this.size) this.items.shift();
        }
        prune(now) {
            const cut = now - this.windowMs;
            while (this.items.length && this.items[0].t < cut) this.items.shift();
        }
        recent(now) { this.prune(now); return this.items.slice(); }
    }

    // ---------- Weapon database ----------
    const WEAPONS = [
        { name: 'AIM-9', cls: 'ir', re: /\baim ?9\b|\bsidewinder\b/ },
        { name: 'R-73', cls: 'ir', re: /\br ?73\b/ },
        { name: 'MAGIC II', cls: 'ir', re: /\bmagic ?(2|ii)\b/ },
        { name: 'MAGIC', cls: 'ir', re: /\bmagic\b/ },
        { name: 'PYTHON', cls: 'ir', re: /\bpython( ?\d)?\b/ },
        { name: 'AIM-120', cls: 'radar', re: /\baim ?120\b|\bamraam\b/ },
        { name: 'AIM-7', cls: 'radar', re: /\baim ?7\b|\bsparrow\b/ },
        { name: 'PHOENIX', cls: 'radar', re: /\bphoenix\b|\baim ?54\b/ },
        { name: 'R-27R', cls: 'radar', re: /\br ?27 ?r\b/ }
    ];
    const FOX_RE = /\bfox ?([1-4])\b/;
    const COUNTER = { ir: 'FLARES', radar: 'CHAFFS', gun: 'EVADING', unknown: 'FLARES/CHAFFS' };
    const REPLY = { ir: 'flares', radar: 'chaffs', gun: 'evading' };

    function findWeapon(n) {
        for (const w of WEAPONS) if (w.re.test(n)) return { weapon: w.name, cls: w.cls, fox: null };
        const f = FOX_RE.exec(n);
        if (f) {
            const x = +f[1];
            return { weapon: 'FOX-' + x, cls: x === 2 ? 'ir' : x === 4 ? 'gun' : 'radar', fox: x };
        }
        return null;
    }

    // Parse one message into combat events.
    function parseMessage(text) {
        const n = normalize(text);
        const ev = [];
        if (!n) return ev;
        let m;
        if (/\blost lock\b|\block lost\b|\bno lock\b/.test(n)) { ev.push({ type: 'LOST_LOCK' }); return ev; }
        if ((m = /\bguns?(?: guns?)* on (.+)$/.exec(n))) {
            ev.push({ type: 'GUNS', target: m[1] });
            return ev;
        }
        if (/\bguns?(?: guns?)* on$/.test(n)) { ev.push({ type: 'GUNS', target: '' }); return ev; }
        if ((m = /\block(?:ing|ed)? (.*?)\s*\bon (.+)$/.exec(n))) {
            ev.push(Object.assign({ type: 'LOCK', target: m[2] }, findWeapon(m[1]) || { weapon: null, cls: 'unknown', fox: null }));
            return ev;
        }
        if (/\bfox ?4\b/.test(n) && !/\baway\b/.test(n)) { /* gun call without target handled via launch below */ }
        const launchWord = /\b(away|firing|fired|launch|launched|shot|rifle)\b/.test(n);
        const fox = FOX_RE.exec(n);
        if (launchWord || fox) {
            const w = findWeapon(n);
            const t = /\b(?:on|at) (.+)$/.exec(n);
            // "fox 2 on A1" style: target after on/at
            ev.push(Object.assign({ type: 'LAUNCH', target: t ? t[1] : '' }, w || { weapon: null, cls: 'unknown', fox: null }));
            return ev;
        }
        if (/\b(hit|splash|kill|killed|downed)\b/.test(n)) ev.push({ type: 'HIT', target: (/\b(?:on|at) (.+)$/.exec(n) || [])[1] || '' });
        else if (/\bmiss(ed)?\b/.test(n)) ev.push({ type: 'MISS', target: (/\b(?:on|at) (.+)$/.exec(n) || [])[1] || '' });
        else if (/\b(flares?|flaring)\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'ir' });
        else if (/\b(chaffs?|chaffing)\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'radar' });
        else if (/\bevading\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'gun' });
        return ev;
    }

    // ---------- CombatEngine ----------
    // States: LOCKED, LAUNCHED, COUNTERED, HIT, MISSED, EXPIRED
    class CombatEngine {
        constructor(settings, aliases, opts) {
            this.s = settings;
            this.aliases = aliases;
            this.now = (opts && opts.now) || (() => Date.now());
            this.engagements = [];
            this.nextId = 1;
            this.listeners = { change: [], reply: [], event: [] };
            this.buffer = new MessageBuffer(settings.get('windowSize'), settings.get('windowMs'));
        }
        on(type, f) { this.listeners[type].push(f); }
        _emit(type, a, b) { this.listeners[type].forEach(f => { try { f(a, b); } catch (e) { /* ignore */ } }); }

        _live(att, phase) {
            return this.engagements.filter(e => e.attacker === att && e.phase === phase);
        }
        _newest(list) { return list.reduce((a, b) => (!a || b.t0 > a.t0 ? b : a), null); }
        _setPhase(e, phase, extra) {
            e.phase = phase; e.changedAt = this.now();
            if (extra) Object.assign(e, extra);
            this._emit('change', e);
        }

        // Entry point for each chat message. mine=true for the user's own messages.
        process(msg) {
            const t = msg.t != null ? msg.t : this.now();
            const text = msg.text || '';
            const sender = msg.sender || '?';
            const mine = !!msg.mine;
            this.buffer.add({ t, sender, text });
            const events = parseMessage(text);
            for (const ev of events) {
                if (mine) { if (ev.type === 'COUNTER') this._onOwnCounter(ev); continue; }
                const att = String(sender).toLowerCase();
                switch (ev.type) {
                    case 'LOCK': this._onLock(att, sender, ev, t); break;
                    case 'LOST_LOCK': this._onLostLock(att); break;
                    case 'LAUNCH': this._onLaunch(att, sender, ev, t); break;
                    case 'GUNS': this._onGuns(att, sender, ev, t); break;
                    case 'HIT': this._onResult(att, ev, 'HIT'); break;
                    case 'MISS': this._onResult(att, ev, 'MISSED'); break;
                }
            }
            return events;
        }

        _make(att, name, ev, phase, t) {
            const e = {
                id: this.nextId++, attacker: att, attackerName: name,
                weapon: ev.weapon || null, cls: ev.cls || 'unknown', fox: ev.fox || null,
                phase, t0: t, lockedAt: phase === 'LOCKED' ? t : null,
                launchedAt: null, deadline: null, replied: false, unresolved: false, changedAt: t
            };
            this.engagements.push(e);
            if (this.engagements.length > 100) {
                const idx = this.engagements.findIndex(x => x.phase !== 'LOCKED' && x.phase !== 'LAUNCHED');
                if (idx >= 0) this.engagements.splice(idx, 1);
            }
            return e;
        }

        _onLock(att, name, ev, t) {
            if (!this.aliases.isUser(ev.target)) return; // not directed at the player
            const existing = this._newest(this._live(att, 'LOCKED'));
            if (existing) {
                existing.lockedAt = t; existing.t0 = t;
                if (ev.weapon) { existing.weapon = ev.weapon; existing.cls = ev.cls; existing.fox = ev.fox; }
                this._emit('change', existing);
                return;
            }
            const e = this._make(att, name, ev, 'LOCKED', t);
            this._emit('change', e);
            this._emit('event', 'LOCK', e);
            // Deliberately no countermeasure response on lock.
        }

        _onLostLock(att) {
            this._live(att, 'LOCKED').forEach(e => this._setPhase(e, 'EXPIRED'));
        }

        _onLaunch(att, name, ev, t) {
            if (ev.target && !this.aliases.isUser(ev.target)) return; // named someone else
            const life = this.s.get('lockLifeMs');
            const lock = this._newest(this._live(att, 'LOCKED').filter(e => t - e.lockedAt <= life));
            if (lock) {
                if (ev.weapon) { lock.weapon = ev.weapon; lock.cls = ev.cls; lock.fox = ev.fox; }
                this._launch(lock, t);
                return;
            }
            // Duplicate launch call shortly after a launch from the same attacker
            const recent = this._newest(this._live(att, 'LAUNCHED').filter(e => t - e.launchedAt < 2000));
            if (recent) return;
            // No lock: only react if the user is explicitly named and class is known
            if (ev.target && this.aliases.isUser(ev.target) && ev.cls !== 'unknown') {
                const e = this._make(att, name, ev, 'LAUNCHED', t);
                this._launch(e, t);
            }
            // A bare "away" with no matching lock is ignored (could be aimed at anyone).
        }

        _onGuns(att, name, ev, t) {
            if (!this.aliases.isUser(ev.target)) return;
            const live = this._newest(this._live(att, 'LAUNCHED').filter(e => e.cls === 'gun' && t - e.launchedAt < this.s.get('counterWindowMs')));
            if (live) { live.launchedAt = t; live.deadline = t + this.s.get('counterWindowMs'); this._emit('change', live); return; }
            // a gun call supersedes any lock from the same attacker
            this._live(att, 'LOCKED').forEach(e => this._setPhase(e, 'EXPIRED'));
            const e = this._make(att, name, { weapon: 'GUNS', cls: 'gun', fox: 4 }, 'LAUNCHED', t);
            this._launch(e, t);
        }

        _launch(e, t) {
            e.launchedAt = t;
            e.deadline = t + this.s.get('counterWindowMs');
            this._setPhase(e, 'LAUNCHED');
            this._emit('event', 'LAUNCH', e);
            const reply = REPLY[e.cls];
            if (reply && this.s.get('autoChat') && !e.replied) {
                e.replied = true;
                this._emit('reply', reply, e);
                this._setPhase(e, 'COUNTERED');
            }
        }

        _onOwnCounter(ev) {
            const list = this.engagements.filter(e => e.phase === 'LAUNCHED' && e.cls === ev.cls);
            const e = this._newest(list);
            if (e) { e.replied = true; this._setPhase(e, 'COUNTERED'); }
        }

        _onResult(att, ev, phase) {
            if (ev.target && !this.aliases.isUser(ev.target)) return;
            let cand = this.engagements.filter(e => e.attacker === att && (e.phase === 'LAUNCHED' || e.phase === 'COUNTERED' || e.phase === 'EXPIRED' && e.unresolved));
            if (!cand.length && ev.target) cand = this.engagements.filter(e => e.phase === 'LAUNCHED' || e.phase === 'COUNTERED');
            const e = this._newest(cand);
            if (e) { this._setPhase(e, phase); this._emit('event', phase, e); }
        }

        tick() {
            const now = this.now();
            const life = this.s.get('lockLifeMs');
            for (const e of this.engagements) {
                if (e.phase === 'LOCKED' && now - e.lockedAt > life) this._setPhase(e, 'EXPIRED');
                else if (e.phase === 'LAUNCHED' && now > e.deadline) {
                    this._setPhase(e, 'EXPIRED', { unresolved: true });
                    this._emit('event', 'UNRESOLVED', e);
                }
            }
            this.buffer.prune(now);
            this._emit('change', null);
        }

        // Seconds left for HUD display
        remaining(e) {
            const now = this.now();
            if (e.phase === 'LAUNCHED') return Math.max(0, Math.ceil((e.deadline - now) / 1000));
            if (e.phase === 'LOCKED') return Math.max(0, Math.ceil((e.lockedAt + this.s.get('lockLifeMs') - now) / 1000));
            return 0;
        }
    }


    // ---------- AudioManager ----------
    class AudioManager {
        constructor(settings) {
            this.s = settings; this.ctx = null; this.last = {};
            const unlock = () => {
                try {
                    const AC = window.AudioContext || window.webkitAudioContext;
                    if (!this.ctx && AC) this.ctx = new AC();
                    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
                } catch (e) { /* ignore */ }
            };
            if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('click', unlock, { once: true });
        }
        _tone(freq, start, dur, type, vol) {
            const c = this.ctx; if (!c) return;
            const o = c.createOscillator(), g = c.createGain();
            o.type = type; o.frequency.value = freq;
            g.gain.setValueAtTime(vol, c.currentTime + start);
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
            o.connect(g); g.connect(c.destination);
            o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
        }
        play(kind) {
            if (!this.s.get('audio') || !this.ctx) return;
            const now = Date.now();
            if (this.last[kind] && now - this.last[kind] < 1500) return;
            this.last[kind] = now;
            if (kind === 'lock') { this._tone(660, 0, 0.12, 'sine', 0.12); this._tone(660, 0.2, 0.12, 'sine', 0.12); }
            else if (kind === 'radar') for (let i = 0; i < 6; i++) this._tone(880, i * 0.15, 0.1, 'sine', 0.15);
            else if (kind === 'ir') for (let i = 0; i < 6; i++) this._tone(i % 2 ? 740 : 520, i * 0.15, 0.12, 'triangle', 0.15);
            else if (kind === 'gun') for (let i = 0; i < 8; i++) this._tone(1200, i * 0.08, 0.06, 'sawtooth', 0.15);
        }
    }

    // ---------- HUDManager ----------
    const COLORS = {
        yellow: '#f5c400', orange: '#ff8c00', blue: '#2f8cff', red: '#e02020',
        green: '#27ae60', gray: '#6b7280'
    };
    class HUDManager {
        constructor(settings, engine) {
            this.s = settings; this.engine = engine; this.root = null; this.nodes = new Map();
        }
        _ensure() {
            if (this.root || typeof document === 'undefined' || !document.body) return;
            const st = document.createElement('style');
            st.textContent =
                '#gdai-hud{position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;align-items:center}' +
                '.gdai-alert{min-width:260px;padding:8px 16px;border-radius:6px;color:#fff;font:600 14px/1.35 Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5);animation:gdai-in .25s ease-out;transition:opacity .5s}' +
                '.gdai-alert.out{opacity:0}' +
                '.gdai-title{font-size:18px;font-weight:800;letter-spacing:.5px}' +
                '.gdai-timer{font-size:26px;font-weight:800;float:right;margin-left:14px}' +
                '@keyframes gdai-in{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:none}}';
            document.head.appendChild(st);
            this.root = document.createElement('div');
            this.root.id = 'gdai-hud';
            document.body.appendChild(this.root);
        }
        static describe(e, engine) {
            let title, color;
            if (e.phase === 'LOCKED') { title = e.cls === 'radar' ? 'RADAR LOCK' : 'MISSILE LOCK'; color = 'yellow'; }
            else if (e.phase === 'LAUNCHED' || e.phase === 'COUNTERED' || e.phase === 'EXPIRED' || e.phase === 'HIT' || e.phase === 'MISSED') {
                if (e.cls === 'gun') { title = 'GUNS ON YOU'; color = 'red'; }
                else if (e.cls === 'ir') { title = 'FOX-2 AWAY'; color = 'orange'; }
                else if (e.cls === 'radar') { title = 'FOX-' + (e.fox === 1 ? 1 : 3) + ' AWAY'; color = 'blue'; }
                else { title = 'MISSILE AWAY'; color = 'orange'; }
                if (e.phase === 'COUNTERED') { title += ' - COUNTERED'; color = 'green'; }
                else if (e.phase === 'HIT') { title = 'HIT'; color = 'red'; }
                else if (e.phase === 'MISSED') { title = 'MISSED'; color = 'green'; }
                else if (e.phase === 'EXPIRED') { title += ' - UNRESOLVED'; color = 'gray'; }
            } else { title = e.phase; color = 'gray'; }
            const timer = engine.remaining(e);
            return {
                title, color,
                lines: [
                    'WEAPON: ' + (e.weapon || 'UNKNOWN'),
                    'ATTACKER: ' + String(e.attackerName).toUpperCase(),
                    'COUNTER: ' + (COUNTER[e.cls] || COUNTER.unknown)
                ],
                timer: (e.phase === 'LAUNCHED' || e.phase === 'LOCKED') ? String(timer) : ''
            };
        }
        render() {
            if (!this.s.get('hud')) { this.clear(); return; }
            this._ensure();
            if (!this.root) return;
            const now = this.engine.now();
            const live = new Set();
            for (const e of this.engine.engagements) {
                const terminal = e.phase !== 'LOCKED' && e.phase !== 'LAUNCHED';
                if (e.phase === 'EXPIRED' && !e.unresolved) { this._drop(e.id); continue; }
                if (terminal && now - e.changedAt > 3500) { this._drop(e.id); continue; }
                live.add(e.id);
                let n = this.nodes.get(e.id);
                if (!n) {
                    const el = document.createElement('div');
                    el.className = 'gdai-alert';
                    const timer = document.createElement('span'); timer.className = 'gdai-timer';
                    const title = document.createElement('div'); title.className = 'gdai-title';
                    const body = document.createElement('div');
                    el.appendChild(timer); el.appendChild(title); el.appendChild(body);
                    this.root.appendChild(el);
                    n = { el, timer, title, body };
                    this.nodes.set(e.id, n);
                }
                const d = HUDManager.describe(e, this.engine);
                n.el.style.background = COLORS[d.color];
                if (d.color === 'yellow') n.el.style.color = '#111';
                else n.el.style.color = '#fff';
                n.timer.textContent = d.timer;
                n.title.textContent = '\u26A0 ' + d.title;
                n.body.textContent = d.lines.join('  |  ');
            }
            for (const id of Array.from(this.nodes.keys())) if (!live.has(id)) this._drop(id);
        }
        _drop(id) {
            const n = this.nodes.get(id); if (!n) return;
            this.nodes.delete(id);
            n.el.classList.add('out');
            setTimeout(() => { if (n.el.parentNode) n.el.parentNode.removeChild(n.el); }, 500);
        }
        clear() { Array.from(this.nodes.keys()).forEach(id => this._drop(id)); }
    }

    // ---------- ChatMonitor ----------
    class ChatMonitor {
        constructor(settings, aliases, engine, audio, hud) {
            this.s = settings; this.aliases = aliases; this.engine = engine; this.audio = audio; this.hud = hud;
            this.seen = new Map(); this.queue = []; this.timer = null;
            this.sentReplies = []; this.started = false;
            engine.on('reply', (text) => this.send(text));
            engine.on('change', () => this.hud.render());
            engine.on('event', (type, e) => {
                if (type === 'LOCK') this.audio.play('lock');
                else if (type === 'LAUNCH') this.audio.play(e.cls === 'gun' ? 'gun' : e.cls === 'radar' ? 'radar' : 'ir');
            });
        }
        ownCallsign() {
            try { const u = window.geofs && geofs.userRecord; return u ? (u.callsign || u.name || '') : ''; } catch (e) { return ''; }
        }
        syncAliases() {
            const own = this.ownCallsign();
            const list = this.s.get('aliases').slice();
            if (own) list.push(own);
            this.aliases.set(list);
        }
        send(text) {
            this.sentReplies.push({ n: normalize(text), t: Date.now() });
            try { if (window.chat && typeof chat.sendMessage === 'function') chat.sendMessage(text); } catch (e) { /* ignore */ }
        }
        _isEcho(text) {
            const now = Date.now(), n = normalize(text);
            this.sentReplies = this.sentReplies.filter(r => now - r.t < 6000);
            const i = this.sentReplies.findIndex(r => r.n === n);
            if (i >= 0) { this.sentReplies.splice(i, 1); return true; }
            return false;
        }
        _isOwnSender(sender) {
            const own = this.ownCallsign();
            return !!own && normalize(own) === normalize(sender);
        }
        ingest(list) {
            if (!Array.isArray(list)) return;
            for (const m of list) {
                if (!m || !m.msg) continue;
                let text = m.msg;
                try { text = decodeURIComponent(String(m.msg).replace(/\+/g, ' ')); } catch (e) { text = String(m.msg); }
                const sender = m.cs || m.callsign || m.name || m.acid || m.id || '?';
                const key = [m.id, m.ts, sender, text].join('|');
                if (this.seen.has(key)) continue;
                this.seen.set(key, 1);
                if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
                this.queue.push({ sender: String(sender), text, t: Date.now() });
                if (this.queue.length > 500) this.queue.shift();
            }
            if (!this.timer) this.timer = setTimeout(() => this._flush(), 40);
        }
        _flush() {
            this.timer = null;
            if (!this.s.get('enabled')) { this.queue.length = 0; return; }
            const start = Date.now();
            while (this.queue.length) {
                const m = this.queue.shift();
                const mine = this._isOwnSender(m.sender);
                if (mine && this._isEcho(m.text)) continue;
                this.engine.process({ sender: m.sender, text: m.text, t: m.t, mine });
                if (Date.now() - start > 6) break;
            }
            if (this.queue.length) this.timer = setTimeout(() => this._flush(), 20);
        }
        start() {
            if (this.started) return; this.started = true;
            this.syncAliases();
            this.s.onChange((k) => { if (k === 'aliases') this.syncAliases(); });
            const orig = window.fetch;
            const self = this;
            if (typeof orig === 'function') {
                window.fetch = function (input) {
                    const p = orig.apply(this, arguments);
                    try {
                        const url = typeof input === 'string' ? input : (input && input.url) || '';
                        if (url.indexOf('mps.geo-fs.com/update') >= 0) {
                            p.then(res => res.clone().json()).then(d => { if (d && d.chatMessages) self.ingest(d.chatMessages); }).catch(() => { /* ignore */ });
                        }
                    } catch (e) { /* ignore */ }
                    return p;
                };
            }
            this.tickTimer = setInterval(() => { if (this.s.get('enabled')) { this.syncAliases(); this.engine.tick(); } }, 250);
        }
    }

    // ---------- UI ----------
    function buildUI(settings, hud) {
        if (typeof document === 'undefined' || !document.body) return;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;font:12px Arial,sans-serif;display:flex;gap:4px';
        const btn = document.createElement('button');
        const paint = () => { btn.textContent = 'Defense AI: ' + (settings.get('enabled') ? 'ON' : 'OFF'); };
        btn.onclick = () => { settings.set('enabled', !settings.get('enabled')); if (!settings.get('enabled')) hud.clear(); paint(); };
        paint();
        const gear = document.createElement('button'); gear.textContent = '\u2699';
        const panel = document.createElement('div');
        panel.style.cssText = 'display:none;position:fixed;bottom:44px;left:10px;background:#222;color:#eee;padding:10px;border-radius:6px;z-index:99999;width:240px';
        [['autoChat', 'Auto chat replies'], ['hud', 'HUD banners'], ['audio', 'Audio warnings']].forEach(([k, label]) => {
            const l = document.createElement('label'); l.style.display = 'block';
            const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!settings.get(k);
            c.onchange = () => settings.set(k, c.checked);
            l.appendChild(c); l.appendChild(document.createTextNode(' ' + label)); panel.appendChild(l);
        });
        const ta = document.createElement('textarea');
        ta.rows = 4; ta.style.cssText = 'width:100%;margin-top:6px'; ta.value = settings.get('aliases').join('\n');
        ta.onchange = () => settings.set('aliases', ta.value.split('\n').map(s => s.trim()).filter(Boolean));
        const cap = document.createElement('div'); cap.textContent = 'My aliases (one per line)';
        panel.appendChild(cap); panel.appendChild(ta);
        gear.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };
        wrap.appendChild(btn); wrap.appendChild(gear);
        document.body.appendChild(wrap); document.body.appendChild(panel);
    }

    // ---------- bootstrap ----------
    const api = { SettingsManager, AliasManager, MessageBuffer, CombatEngine, HUDManager, AudioManager, ChatMonitor, parseMessage, normalize, canon };
    function init() {
        const settings = new SettingsManager();
        const aliases = new AliasManager(settings.get('aliases'));
        const engine = new CombatEngine(settings, aliases);
        const hud = new HUDManager(settings, engine);
        const audio = new AudioManager(settings);
        const monitor = new ChatMonitor(settings, aliases, engine, audio, hud);
        api.instance = { settings, aliases, engine, hud, audio, monitor };
        return api.instance;
    }
    window.__GeoFSDefenseAI = api;
    if (!window.__GeoFSDefenseAI_NOAUTO) {
        const go = () => { const i = init(); buildUI(i.settings, i.hud); i.monitor.start(); };
        if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
    }
})();
