// ==UserScript==
// @name         GeoFS Defensive AI
// @namespace    GeoFS
// @version      4.2
// @description  Combat assistant: auto identity detection, lock -> fire -> countermeasure -> hit/miss state engine, confidence scoring, HUD, settings (Alt+D)
// @match        https://www.geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---------- helpers ----------
    const NUM_WORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };

    function normalize(s) {
        let t = String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
        t = t.split(' ').map(w => NUM_WORDS[w] || w).join(' ');
        return t.replace(/\s+/g, ' ');
    }
    // Canonical callsign form: "Alpha One" / "alpha-1" / "Alpha1" / "A1" -> "a1"
    function canon(s) {
        return normalize(s).replace(/\balpha\b|\balfa\b/g, 'a').replace(/\s+/g, '');
    }

    // ---------- SettingsManager ----------
    class SettingsManager {
        static get KEY() { return 'geofs_defense_ai_v4'; }
        static get DEFAULTS() {
            return {
                enabled: true, autoChat: true, hud: true, sounds: false,
                customAliases: [], storedAliases: [], disabledDetected: [],
                cooldowns: {}, wizardDone: false,
                windowMs: 60000, windowSize: 50, lockLifeMs: 30000, counterWindowMs: 5000,
                confidenceMin: 70, dedupeMs: 10000, replyCooldownMs: 5000
            };
        }
        constructor() {
            this.data = Object.assign({}, SettingsManager.DEFAULTS);
            this.listeners = [];
            try {
                const ls = window.localStorage;
                const raw = ls && ls.getItem(SettingsManager.KEY);
                if (raw) Object.assign(this.data, JSON.parse(raw));
                else {
                    const old = ls && ls.getItem('geofs_defense_ai_v3');
                    if (old) {
                        const o = JSON.parse(old);
                        ['enabled', 'autoChat', 'hud'].forEach(k => { if (typeof o[k] === 'boolean') this.data[k] = o[k]; });
                        if (typeof o.audio === 'boolean') this.data.sounds = o.audio;
                    }
                }
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
    // Detects the logged-in player by scanning GeoFS globals.
    class IdentityDetector {
        constructor() { this.info = IdentityDetector.empty(); }
        static empty() { return { callsign: '', username: '', display: '', pilot: '', myId: '', sources: [] }; }
        static str(v) {
            if (typeof v !== 'string' && typeof v !== 'number') return '';
            const s = String(v).trim();
            return s.length > 0 && s.length <= 40 ? s : '';
        }
        _roots() {
            const r = [], w = window;
            const add = (n, o) => { if (o && typeof o === 'object') r.push([n, o]); };
            try {
                const g = w.geofs, mp = w.multiplayer;
                add('geofs.userRecord', g && g.userRecord);
                add('geofs.user', g && g.user);
                add('geofs.api', g && g.api);
                add('multiplayer', mp);
                add('multiplayer.user', mp && mp.user);
                add('multiplayer.userRecord', mp && mp.userRecord);
                add('multiplayer.player', mp && mp.player);
                add('multiplayer.aircraft', mp && mp.aircraft);
                if (mp && mp.myId != null && mp.users) add('multiplayer.users[myId]', mp.users[mp.myId]);
                add('window.user', w.user);
                add('window.userRecord', w.userRecord);
                add('geofs.aircraft.instance', g && g.aircraft && g.aircraft.instance);
            } catch (e) { /* ignore */ }
            return r;
        }
        static classify(key, userLike) {
            const k = String(key).toLowerCase().replace(/[_-]/g, '');
            if (k === 'callsign') return 'callsign';
            if (k === 'username' || k === 'login' || k === 'accountname') return 'username';
            if (k === 'displayname' || k === 'nickname' || k === 'nick') return 'display';
            if (k === 'pilotname' || k === 'pilot' || k === 'fullname' || k === 'realname') return 'pilot';
            if (k === 'name' && userLike) return 'username';
            return '';
        }
        detect() {
            const info = IdentityDetector.empty();
            const seen = new Set();
            const scan = (src, obj, depth) => {
                if (!obj || seen.has(obj)) return;
                seen.add(obj);
                const userLike = /user|player/i.test(src);
                let keys; try { keys = Object.keys(obj).slice(0, 120); } catch (e) { return; }
                for (const k of keys) {
                    let v; try { v = obj[k]; } catch (e) { continue; }
                    const cat = IdentityDetector.classify(k, userLike);
                    const s = IdentityDetector.str(v);
                    if (cat && s && !info[cat]) { info[cat] = s; info.sources.push(cat + '<-' + src + '.' + k); }
                    else if (depth < 1 && v && typeof v === 'object' && /^(user|userrecord|player|account|profile)$/i.test(k)) scan(src + '.' + k, v, depth + 1);
                }
            };
            for (const [n, o] of this._roots()) scan(n, o, 0);
            try {
                if (!info.callsign && typeof document !== 'undefined') {
                    const el = document.querySelector('input[name="callsign"], #callsign, .geofs-callsign');
                    const s = el && IdentityDetector.str(el.value || el.textContent);
                    if (s) { info.callsign = s; info.sources.push('callsign<-DOM'); }
                }
                const mp = window.multiplayer;
                if (mp && mp.myId != null) info.myId = String(mp.myId);
            } catch (e) { /* ignore */ }
            this.info = info;
            return info;
        }
        aliases() {
            const i = this.info, out = [];
            [i.callsign, i.username, i.display, i.pilot].forEach(s => { if (s && !out.some(o => canon(o) === canon(s))) out.push(s); });
            return out;
        }
    }

    class AliasManager {
        constructor(settings, identity) {
            this.s = settings; this.identity = identity;
            this.detected = []; this.custom = []; this.stored = []; this.active = [];
            this.status = 'PENDING'; this.canons = new Set(); this._key = '';
            this.rebuild();
        }
        _norm(list) {
            const out = [];
            list.forEach(a => { if (a && !out.some(o => canon(o) === canon(a))) out.push(String(a).trim()); });
            return out;
        }
        rebuild() {
            const off = new Set((this.s.get('disabledDetected') || []).map(canon));
            this.custom = this._norm(this.s.get('customAliases') || []);
            this.stored = this._norm(this.s.get('storedAliases') || []);
            const det = this.detected.filter(a => !off.has(canon(a)));
            // detected first, stored fallback, then manual
            this.active = this._norm((det.length ? det : (this.detected.length ? [] : this.stored)).concat(this.custom));
            this.canons = new Set(this.active.map(canon).filter(Boolean));
        }
        // Re-detect identity. Returns what happened so callers can notify.
        refresh() {
            const info = this.identity.detect();
            this.detected = this.identity.aliases();
            const key = this.detected.map(canon).join('|');
            const prev = this._key;
            let changed = false;
            if (this.detected.length) {
                if (key !== prev) {
                    changed = !!prev;
                    this.s.set('storedAliases', this.detected.slice());
                    this._key = key;
                }
                this.status = 'OK';
            } else {
                this.status = 'FAILED';
            }
            this.rebuild();
            return { status: this.status, changed, callsign: info.callsign || this.detected[0] || '' };
        }
        ownNames() { return this.detected.length ? this.detected : this.stored; }
        // Is the text after "on" the user? Exact canonical match on first 1-3 words.
        isUser(text) {
            const words = normalize(text).split(' ').filter(Boolean);
            for (let n = Math.min(3, words.length); n >= 1; n--) {
                if (this.canons.has(canon(words.slice(0, n).join(' ')))) return true;
            }
            return false;
        }
        // Find any alias n-gram inside free text; returns the matched words or ''.
        findIn(text) {
            const words = normalize(text).split(' ').filter(Boolean);
            for (let i = 0; i < words.length; i++) {
                for (let n = Math.min(3, words.length - i); n >= 1; n--) {
                    const g = words.slice(i, i + n).join(' ');
                    if (this.canons.has(canon(g))) return g;
                }
            }
            return '';
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
    // Specific seeker variants precede family names with ambiguous guidance.
    const WEAPONS = [
        { name: 'R-27T/ET', cls: 'ir', re: /\br ?27 ?(?:et|t)(?:1)?\b|\balamo ?[bd]\b/ },
        { name: 'R-27R/ER', cls: 'radar', re: /\br ?27 ?(?:er|r)(?:1)?\b|\balamo ?[ac]\b/ },
        { name: 'R-27P/EP', cls: 'passive', re: /\br ?27 ?(?:ep|p)(?:1)?\b|\balamo ?[ef]\b/ },
        { name: 'R-23T/R-24T', cls: 'ir', re: /\br ?(?:23|24) ?t\b|\bapex ?[bd]\b/ },
        { name: 'R-23R/R-24R', cls: 'radar', re: /\br ?(?:23|24) ?r\b|\bapex ?[ac]\b/ },
        { name: 'R-40T/TD', cls: 'ir', re: /\br ?40 ?t(?:d ?1?|1)?\b|\bacrid ?b\b/ },
        { name: 'R-40R/RD', cls: 'radar', re: /\br ?40 ?r(?:d ?1?|1)?\b|\bacrid ?a\b/ },
        { name: 'R-8T/R-98T', cls: 'ir', re: /\br ?(?:8|98) ?(?:mt|t)\b|\banab ?b\b/ },
        { name: 'R-8R/R-98R', cls: 'radar', re: /\br ?(?:8|98) ?(?:mr|r)\b|\banab ?a\b/ },
        { name: 'R-3S/R-13M', cls: 'ir', re: /\br ?(?:3 ?s|13 ?m ?1?)\b|\bk ?13 ?a\b|\batoll ?[abd]\b/ },
        { name: 'R-3R', cls: 'radar', re: /\br ?3 ?r\b|\batoll ?c\b/ },
        { name: 'MICA IR', cls: 'ir', re: /\bmica ?(?:ng ?)?(?:ir|infrared)\b/ },
        { name: 'MICA EM/RF', cls: 'radar', re: /\bmica ?(?:ng ?)?(?:em|rf|radar)\b/ },
        { name: 'R.530 IR', cls: 'ir', re: /\b(?:matra ?)?r ?530 ?ir\b/ },
        { name: 'R.530 radar', cls: 'radar', re: /\b(?:matra ?)?r ?530 ?(?:em|rf|radar)\b/ },
        { name: 'AIM-4 IR', cls: 'ir', re: /\baim ?4 ?(?:b|c|d|g)\b/ },
        { name: 'AIM-4 radar', cls: 'radar', re: /\baim ?4 ?(?:a|e|f)\b/ },
        { name: 'AIM-9C', cls: 'radar', re: /\baim ?9 ?c\b|\bside ?winder ?c\b/ },
        { name: 'AIM-9', cls: 'ir', re: /\baim ?9(?: ?[a-z](?: ?\d+)?)?\b|\bside ?winder\b|\bgar ?8\b|\brb ?24(?: ?j)?\b/ },
        { name: 'AIM-7', cls: 'radar', re: /\baim ?7(?: ?[a-z](?: ?\d+)?)?\b|\bsparrow\b|\brb ?71\b/ },
        { name: 'AIM-54', cls: 'radar', re: /\baim ?54(?: ?[ac])?\b|\bphoenix\b/ },
        { name: 'AIM-120', cls: 'radar', re: /\baim ?120(?: ?[a-d](?: ?\d+)?)?\b|\bamraam\b|\brb ?99\b/ },
        { name: 'AIM-132', cls: 'ir', re: /\baim ?132\b|\basraam\b/ },
        { name: 'AIM-174B', cls: 'radar', re: /\baim ?174 ?b?\b/ },
        { name: 'AIM-260', cls: 'radar', re: /\baim ?260\b|\bjatm\b/ },
        { name: 'AIM-26 Falcon', cls: 'radar', re: /\baim ?26(?: ?[ab])?\b|\bsuper ?falcon\b|\brb ?27\b/ },
        { name: 'AIM-47 Falcon', cls: 'radar', re: /\baim ?47(?: ?a)?\b|\bgar ?9\b/ },
        { name: 'AIM-4 Falcon', cls: 'mixed', re: /\baim ?4\b|\bfalcon\b/ },
        { name: 'R-60', cls: 'ir', re: /\br ?60(?: ?mk?)?\b|\baa ?8\b|\baphid\b/ },
        { name: 'R-73/R-74', cls: 'ir', re: /\br ?7[34](?: ?m ?2?)?\b|\brvv ?md ?2?\b|\baa ?11\b|\barcher\b/ },
        { name: 'R-77', cls: 'radar', re: /\br ?77(?: ?m| ?1)?\b|\brvv ?(?:ae|sd)\b|\baa ?12\b|\badder\b/ },
        { name: 'R-33', cls: 'radar', re: /\br ?33(?: ?s)?\b|\baa ?9\b|\bamos\b/ },
        { name: 'R-37', cls: 'radar', re: /\br ?37(?: ?m)?\b|\brvv ?bd\b|\baa ?13\b|\baxehead\b/ },
        { name: 'R-27', cls: 'mixed', re: /\br ?27\b|\baa ?10\b|\balamo\b/ },
        { name: 'R-23/R-24', cls: 'mixed', re: /\br ?(?:23|24)\b|\baa ?7\b|\bapex\b/ },
        { name: 'R-40', cls: 'mixed', re: /\br ?40\b|\baa ?6\b|\bacrid\b/ },
        { name: 'R-8/R-98', cls: 'mixed', re: /\br ?(?:8|98)\b|\baa ?3\b|\banab\b/ },
        { name: 'K-13/R-3', cls: 'mixed', re: /\bk ?13\b|\br ?3\b|\baa ?2\b|\batoll\b/ },
        { name: 'R-4T', cls: 'ir', re: /\br ?4 ?t\b/ },
        { name: 'R-4R', cls: 'radar', re: /\br ?4 ?r\b/ },
        { name: 'R-4', cls: 'mixed', re: /\br ?4\b|\baa ?5\b|\bash\b/ },
        { name: 'K-5', cls: 'beam', re: /\bk ?5(?: ?m)?\b|\brs ?2 ?(?:us|u|s|m)\b|\baa ?1\b|\balkali\b/ },
        { name: 'MAGIC II', cls: 'ir', re: /\b(?:r ?550 ?)?magic ?(?:2|ii)\b/ },
        { name: 'MAGIC', cls: 'ir', re: /\br ?550\b|\bmagic(?: ?1| ?i)?\b/ },
        { name: 'Super 530', cls: 'radar', re: /\b(?:matra ?)?super ?530(?: ?[df])?\b/ },
        { name: 'R.530', cls: 'mixed', re: /\b(?:matra ?)?r ?530\b/ },
        { name: 'MICA', cls: 'mixed', re: /\bmica(?: ?ng)?\b/ },
        { name: 'Meteor', cls: 'radar', re: /\bmeteor\b/ },
        { name: 'IRIS-T', cls: 'ir', re: /\biris ?t\b|\baim ?2000\b|\brb ?98\b/ },
        { name: 'Python', cls: 'ir', re: /\bpython(?: ?[3-5]| ?iii| ?iv| ?v)?\b/ },
        { name: 'Shafrir', cls: 'ir', re: /\bshafrir(?: ?[12])?\b/ },
        { name: 'Derby', cls: 'radar', re: /\b(?:i ?)?derby(?: ?er)?\b/ },
        { name: 'PL-5A', cls: 'radar', re: /\bpl ?5 ?a\b/ },
        { name: 'PL-2/PL-5/PL-7', cls: 'ir', re: /\bpl ?(?:2|5|7)(?: ?[a-e])?\b/ },
        { name: 'PL-8', cls: 'ir', re: /\bpl ?8(?: ?[ab])?\b/ },
        { name: 'PL-9', cls: 'ir', re: /\bpl ?9(?: ?c)?\b/ },
        { name: 'PL-10', cls: 'ir', re: /\bpl ?10(?: ?e)?\b/ },
        { name: 'PL-11', cls: 'radar', re: /\bpl ?11(?: ?[ab])?\b/ },
        { name: 'PL-12/SD-10', cls: 'radar', re: /\bpl ?12(?: ?[a-d])?\b|\bsd ?10(?: ?a)?\b/ },
        { name: 'PL-15', cls: 'radar', re: /\bpl ?15(?: ?e)?\b/ },
        { name: 'PL-17', cls: 'radar', re: /\bpl ?17\b/ },
        { name: 'TY-90', cls: 'ir', re: /\bty ?90\b|\btian ?yan ?90\b/ },
        { name: 'AAM-1', cls: 'ir', re: /\baam ?1\b|\btype ?69\b/ },
        { name: 'AAM-2', cls: 'ir', re: /\baam ?2\b/ },
        { name: 'AAM-3', cls: 'ir', re: /\baam ?3\b|\btype ?90\b/ },
        { name: 'AAM-4', cls: 'radar', re: /\baam ?4(?: ?b)?\b|\btype ?99\b/ },
        { name: 'AAM-5', cls: 'ir', re: /\baam ?5(?: ?b)?\b|\btype ?04\b/ },
        { name: 'Astra', cls: 'radar', re: /\bastra(?: ?mk ?(?:1|2|3|i|ii|iii))?\b/ },
        { name: 'R-Darter', cls: 'radar', re: /\br ?darter\b/ },
        { name: 'A-Darter', cls: 'ir', re: /\ba ?darter\b|\bagile ?darter\b/ },
        { name: 'V3 Kukri', cls: 'ir', re: /\bv ?3 ?[abs]?\b|\bkukri\b/ },
        { name: 'V3C Darter', cls: 'ir', re: /\bv ?3 ?c\b/ },
        { name: 'Skyflash', cls: 'radar', re: /\bsky ?flash\b/ },
        { name: 'Firestreak', cls: 'ir', re: /\bfire ?streak\b/ },
        { name: 'Red Top', cls: 'ir', re: /\bred ?top\b/ },
        { name: 'SRAAM', cls: 'ir', re: /\bsraam\b/ },
        { name: 'Fireflash', cls: 'beam', re: /\bfire ?flash\b/ },
        { name: 'R-55', cls: 'ir', re: /\br ?55\b/ },
        { name: 'AIM-95 Agile', cls: 'ir', re: /\baim ?95\b|\bagile\b/ },
        { name: 'MAA-1 Piranha', cls: 'ir', re: /\bmaa ?1(?: ?[ab])?\b|\bpiranha\b/ },
        { name: 'Selenia Aspide', cls: 'radar', re: /\baspide(?: ?1 ?a?)?\b/ },
        { name: 'TC-1 Sky Sword I', cls: 'ir', re: /\btc ?1\b|\bsky ?sword ?(?:1|i)\b|\btien ?chien ?(?:1|i)\b/ },
        { name: 'TC-2 Sky Sword II', cls: 'radar', re: /\btc ?2\b|\bsky ?sword ?(?:2|ii)\b|\btien ?chien ?(?:2|ii)\b/ },
        { name: 'Bozdogan', cls: 'ir', re: /\bbozdogan\b/ },
        { name: 'Gokdogan', cls: 'radar', re: /\bgokdogan\b/ },
        { name: 'Fakour-90', cls: 'radar', re: /\bfakour ?90\b/ },
        { name: 'Mistral ATAM', cls: 'ir', re: /\bmistral(?: ?atam)?\b|\batam\b/ },
        { name: 'ATAS Stinger', cls: 'ir', re: /\baim ?92\b|\batas\b|\bstinger\b/ }
    ];
    const FOX_RE = /\bfox ?([1-4])\b/;
    const COUNTER = { ir: 'FLARES', radar: 'CHAFFS', mixed: 'FLARES/CHAFFS', passive: 'EVADING', beam: 'EVADING', gun: 'EVADING', unknown: 'FLARES/CHAFFS' };
    const REPLY = { ir: 'flares', radar: 'chaffs', mixed: 'flares chaffs', passive: 'evading', beam: 'evading', gun: 'evading' };

    function findWeapon(n) {
        const f = FOX_RE.exec(n);
        for (const w of WEAPONS) {
            if (!w.re.test(n)) continue;
            const cls = w.cls === 'mixed' && f && +f[1] <= 3 ? (+f[1] === 2 ? 'ir' : 'radar') : w.cls;
            return { weapon: w.name, cls, fox: f ? +f[1] : null };
        }
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
            const t = /\b(?:on|at) (.+)$/.exec(n);
            const w = findWeapon(t ? n.slice(0, t.index) : n);
            // "fox 2 on A1" style: target after on/at
            ev.push(Object.assign({ type: 'LAUNCH', target: t ? t[1] : '' }, w || { weapon: null, cls: 'unknown', fox: null }));
            return ev;
        }
        if (/\b(hit|splash|kill|killed|downed)\b/.test(n)) ev.push({ type: 'HIT', target: (/\b(?:on|at) (.+)$/.exec(n) || [])[1] || '' });
        else if (/\bmiss(ed)?\b/.test(n)) ev.push({ type: 'MISS', target: (/\b(?:on|at) (.+)$/.exec(n) || [])[1] || '' });
        else if (/\b(flares?|flaring)\b/.test(n) && /\b(chaffs?|chaffing)\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'mixed' });
        else if (/\b(flares?|flaring)\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'ir' });
        else if (/\b(chaffs?|chaffing)\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'radar' });
        else if (/\bevading\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'gun' });
        return ev;
    }

    // ---------- ThreatStateManager ----------
    // States: LOCKED, LAUNCHED, COUNTERED, HIT, MISSED, EXPIRED
    class ThreatStateManager {
        constructor(settings, aliases, opts) {
            this.s = settings;
            this.aliases = aliases;
            this.now = (opts && opts.now) || (() => Date.now());
            this.engagements = [];
            this.nextId = 1;
            this.listeners = { change: [], reply: [], event: [] };
        }
        findLock(att, t) {
            const life = this.s.get('lockLifeMs');
            return this._newest(this._live(att, 'LOCKED').filter(e => t - e.lockedAt <= life));
        }
        on(type, f) { this.listeners[type].push(f); }
        _emit(type, a, b) {
            let accepted = false;
            this.listeners[type].forEach(f => { try { if (f(a, b) === true) accepted = true; } catch (e) { /* ignore */ } });
            return accepted;
        }

        _live(att, phase) {
            return this.engagements.filter(e => e.attacker === att && e.phase === phase);
        }
        _newest(list) { return list.reduce((a, b) => (!a || b.t0 > a.t0 ? b : a), null); }
        _setPhase(e, phase, extra) {
            e.phase = phase; e.changedAt = this.now();
            if (extra) Object.assign(e, extra);
            this._emit('change', e);
        }

        // Apply one already-validated combat event.
        apply(ev, sender, t, mine) {
            if (mine) { if (ev.type === 'COUNTER') this._onOwnCounter(ev); return; }
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
                if (this._emit('reply', reply, e)) {
                    e.replied = true;
                    this._setPhase(e, 'COUNTERED');
                }
            }
        }

        _onOwnCounter(ev) {
            const list = this.engagements.filter(e => e.phase === 'LAUNCHED' &&
                (e.cls === ev.cls || ev.cls === 'mixed' && (e.cls === 'ir' || e.cls === 'radar') ||
                    ev.cls === 'gun' && (e.cls === 'beam' || e.cls === 'passive')));
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
            if (!this.s.get('sounds') || !this.ctx) return;
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
                '.gdai-toast{min-width:260px;padding:6px 14px;border-radius:6px;color:#fff;font:700 13px Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5);animation:gdai-in .25s ease-out;transition:opacity .5s}' +
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
            for (const e of this._top(now)) {
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
                n.body.textContent = d.lines.join('  |  ') + (this.extra > 0 ? '  |  +' + this.extra + ' MORE' : '');
            }
            for (const id of Array.from(this.nodes.keys())) if (!live.has(id)) this._drop(id);
        }
        // Only the highest-priority active engagement is shown: radar > IR > guns > other.
        _top(now) {
            const rank = e => {
                if (e.phase === 'LAUNCHED') return { radar: 1, ir: 2, gun: 3 }[e.cls] || 4;
                return e.phase === 'LOCKED' ? 5 : 6;
            };
            const c = this.engine.engagements.filter(e => {
                if (e.phase === 'EXPIRED' && !e.unresolved) return false;
                return !(e.phase !== 'LOCKED' && e.phase !== 'LAUNCHED' && now - e.changedAt > 3500);
            });
            c.sort((a, b) => rank(a) - rank(b) || b.t0 - a.t0);
            this.extra = Math.max(0, c.length - 1);
            return c.slice(0, 1);
        }
        notify(text, color, ms) {
            if (!this.s.get('hud')) return;
            this._ensure();
            if (!this.root) return;
            const el = document.createElement('div');
            el.className = 'gdai-toast';
            el.style.background = COLORS[color || 'orange'];
            el.textContent = text;
            this.root.appendChild(el);
            setTimeout(() => {
                el.classList.add('out');
                setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
            }, ms || 4000);
        }
        _drop(id) {
            const n = this.nodes.get(id); if (!n) return;
            this.nodes.delete(id);
            n.el.classList.add('out');
            setTimeout(() => { if (n.el.parentNode) n.el.parentNode.removeChild(n.el); }, 500);
        }
        clear() { Array.from(this.nodes.keys()).forEach(id => this._drop(id)); }
    }

    // ---------- ThreatDetector ----------
    // Parses chat, scores confidence, suppresses duplicates, feeds ThreatStateManager.
    class ThreatDetector {
        constructor(settings, aliases, state) {
            this.s = settings; this.aliases = aliases; this.state = state;
            this.buffer = new MessageBuffer(settings.get('windowSize'), settings.get('windowMs'));
            this.recent = new Map();
            this.last = [];
        }
        tick() {
            const now = this.state.now();
            this.state.tick();
            this.buffer.prune(now);
            for (const [k, t] of this.recent) if (now - t > this.s.get('dedupeMs')) this.recent.delete(k);
        }
        // Confidence: alias +40, weapon +35, combat phrase +15, related recent message +10.
        score(parts) {
            return (parts.alias ? 40 : 0) + (parts.weapon ? 35 : 0) + (parts.phrase ? 15 : 0) + (parts.related ? 10 : 0);
        }
        handle(msg) {
            const t = msg.t != null ? msg.t : this.state.now();
            const text = msg.text || '';
            const sender = msg.sender || '?';
            const mine = !!msg.mine;
            const related = this.buffer.items.some(m => m.sender === sender && t - m.t <= 10000);
            this.buffer.add({ t, sender, text });
            const events = parseMessage(text);
            const rec = { t, sender, text, events: events.map(e => e.type), score: 0, accepted: false };
            this.last.push(rec);
            if (this.last.length > 15) this.last.shift();
            const att = String(sender).toLowerCase();
            for (const ev of events) {
                if (mine || ev.type === 'LOST_LOCK' || ev.type === 'HIT' || ev.type === 'MISS' || ev.type === 'COUNTER') {
                    this.state.apply(ev, sender, t, mine);
                    continue;
                }
                if ((ev.type === 'LAUNCH' || ev.type === 'GUNS') && !ev.target) {
                    const f = this.aliases.findIn(text);
                    if (f) ev.target = f;
                }
                const lock = ev.type === 'LAUNCH' ? this.state.findLock(att, t) : null;
                const named = !!ev.target;
                const targetsMe = named && this.aliases.isUser(ev.target);
                if (named && !targetsMe) continue;
                const parts = {
                    alias: targetsMe || (!named && !!lock),
                    weapon: ev.type === 'GUNS' || (ev.cls && ev.cls !== 'unknown') || !!(lock && lock.cls !== 'unknown'),
                    phrase: true,
                    related
                };
                rec.score = Math.max(rec.score, this.score(parts));
                if (rec.score < this.s.get('confidenceMin')) continue;
                if (ev.type === 'GUNS' || (ev.type === 'LAUNCH' && !lock)) {
                    const key = ev.type + '|' + (ev.cls || 'gun');
                    const prev = this.recent.get(key);
                    if (prev != null && t - prev < this.s.get('dedupeMs')) continue;
                    this.recent.set(key, t);
                }
                rec.accepted = true;
                this.state.apply(ev, sender, t, false);
            }
            return events;
        }
    }

    // ---------- ChatMonitor ----------
    class ChatMonitor {
        constructor(ctx) {
            Object.assign(this, ctx); // settings, aliases, state, detector, audio, hud, ui
            this.s = ctx.settings;
            this.seen = new Map(); this.queue = []; this.timer = null;
            this.sentReplies = []; this.started = false; this.startedAt = Date.now();
            this.lastSendStatus = 'No reply attempted';
            this.failWarned = false; this.wizardShown = false;
            this.state.on('reply', (text) => this.send(text));
            this.state.on('change', () => this.hud.render());
            this.state.on('event', (type, e) => {
                if (type === 'LOCK') this.audio.play('lock');
                else if (type === 'LAUNCH') this.audio.play(e.cls === 'mixed' ? 'radar' : e.cls);
            });
        }
        send(text) {
            const now = Date.now();
            const cd = this.s.get('cooldowns') || {};
            if (now - (cd.lastReply || 0) < this.s.get('replyCooldownMs')) {
                this.lastSendStatus = 'Reply skipped: cooldown';
                return false;
            }
            try {
                const mp = window.multiplayer;
                const chat = window.chat;
                if (mp && typeof mp.setChatMessage === 'function') mp.setChatMessage(text);
                else if (chat && typeof chat.sendMessage === 'function') chat.sendMessage(text);
                else throw new Error('GeoFS chat API is unavailable. Wait for multiplayer to load.');
            } catch (error) {
                this.lastSendStatus = 'Send failed: ' + String(error.message || error);
                console.error('[GeoFS Defensive AI] ' + this.lastSendStatus, error);
                this.hud.notify(this.lastSendStatus, 'orange', 6000);
                return false;
            }
            this.s.set('cooldowns', Object.assign({}, cd, { lastReply: now }));
            this.sentReplies.push({ n: normalize(text), t: now });
            this.lastSendStatus = 'Queued for GeoFS chat: ' + text;
            return true;
        }
        _isEcho(text) {
            const now = Date.now(), n = normalize(text);
            this.sentReplies = this.sentReplies.filter(r => now - r.t < 6000);
            const i = this.sentReplies.findIndex(r => r.n === n);
            if (i >= 0) { this.sentReplies.splice(i, 1); return true; }
            return false;
        }
        _isOwn(m) {
            const myId = this.aliases.identity.info.myId;
            if (myId && m.id != null && String(m.id) === myId) return true;
            const s = canon(m.sender);
            return !!s && this.aliases.ownNames().some(n => canon(n) === s);
        }
        ingest(list) {
            if (!Array.isArray(list)) return;
            for (const m of list) {
                if (!m || !m.msg) continue;
                let text;
                try { text = decodeURIComponent(String(m.msg).replace(/\+/g, ' ')); } catch (e) { text = String(m.msg); }
                const sender = m.cs || m.callsign || m.name || m.acid || m.id || '?';
                const key = [m.id, m.ts, sender, text].join('|');
                if (this.seen.has(key)) continue;
                this.seen.set(key, 1);
                if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
                this.queue.push({ id: m.id, sender: String(sender), text, t: Date.now() });
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
                const mine = this._isOwn(m);
                if (mine && this._isEcho(m.text)) continue;
                this.detector.handle({ sender: m.sender, text: m.text, t: m.t, mine });
                if (Date.now() - start > 6) break;
            }
            if (this.queue.length) this.timer = setTimeout(() => this._flush(), 20);
        }
        checkIdentity() {
            const r = this.aliases.refresh();
            if (r.changed) this.hud.notify('CALLSIGN UPDATED: ' + r.callsign, 'green', 4000);
            if (r.status === 'FAILED') {
                if (!this.failWarned) { this.failWarned = true; this.hud.notify('\u26A0 GeoFS Identity Detection Failed', 'orange', 6000); }
                if (!this.aliases.active.length && !this.wizardShown && !this.s.get('wizardDone') && Date.now() - this.startedAt > 8000) {
                    this.wizardShown = true;
                    if (this.ui && this.ui.showWizard) this.ui.showWizard();
                }
            } else this.failWarned = false;
        }
        _hook() {
            const self = this;
            const orig = window.fetch;
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
            // GeoFS multiplayer may also use XMLHttpRequest
            const XHR = window.XMLHttpRequest;
            if (XHR && XHR.prototype) {
                const open = XHR.prototype.open;
                XHR.prototype.open = function (method, url) {
                    try {
                        if (String(url).indexOf('mps.geo-fs.com/update') >= 0) {
                            this.addEventListener('load', function () {
                                try { const d = JSON.parse(this.responseText); if (d && d.chatMessages) self.ingest(d.chatMessages); } catch (e) { /* ignore */ }
                            });
                        }
                    } catch (e) { /* ignore */ }
                    return open.apply(this, arguments);
                };
            }
        }
        start() {
            if (this.started) return; this.started = true;
            this.checkIdentity();
            this.s.onChange((k) => { if (k === 'customAliases' || k === 'disabledDetected') this.aliases.rebuild(); });
            this._hook();
            let n = 0;
            this.tickTimer = setInterval(() => {
                if (!this.s.get('enabled')) return;
                if (++n % 4 === 0) this.checkIdentity();
                this.detector.tick();
            }, 250);
        }
    }

    // ---------- UI: settings panel, debug panel, wizard ----------
    function buildUI(ctx) {
        if (typeof document === 'undefined' || !document.body) return {};
        const { settings, aliases, state, detector, hud } = ctx;
        const st = document.createElement('style');
        st.textContent =
            '#gdai-panel{display:none;position:fixed;bottom:44px;left:10px;width:300px;max-height:80vh;overflow:auto;background:#1e1e1e;color:#eee;padding:10px;border-radius:8px;z-index:100000;font:12px Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6)}' +
            '#gdai-panel h4{margin:8px 0 4px;font-size:12px;color:#f5c400}#gdai-panel label{display:block;margin:2px 0}' +
            '#gdai-panel input[type=text]{background:#333;color:#eee;border:1px solid #555;padding:2px 4px;width:170px}' +
            '#gdai-panel button,.gdai-btn{background:#444;color:#fff;border:1px solid #666;border-radius:4px;padding:2px 8px;margin:2px;cursor:pointer}' +
            '#gdai-panel pre{white-space:pre-wrap;font:11px monospace;background:#111;padding:6px;margin:4px 0;max-height:220px;overflow:auto}' +
            '#gdai-wizard{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100001;display:flex;align-items:center;justify-content:center;font:13px Arial,sans-serif}' +
            '#gdai-wizard div{background:#222;color:#eee;padding:18px;border-radius:8px;width:320px}#gdai-wizard input{width:100%;box-sizing:border-box;margin:4px 0 10px;padding:4px}';
        document.head.appendChild(st);

        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:100000;display:flex;gap:4px;font:12px Arial,sans-serif';
        const btn = document.createElement('button'); btn.className = 'gdai-btn';
        const paint = () => { btn.textContent = 'Defense AI: ' + (settings.get('enabled') ? 'ON' : 'OFF'); };
        btn.onclick = () => { settings.set('enabled', !settings.get('enabled')); if (!settings.get('enabled')) hud.clear(); paint(); sync(); };
        paint();
        const gear = document.createElement('button'); gear.className = 'gdai-btn'; gear.textContent = '\u2699';
        wrap.appendChild(btn); wrap.appendChild(gear);

        const panel = document.createElement('div'); panel.id = 'gdai-panel';
        const toggle = () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; if (panel.style.display === 'block') sync(); };
        gear.onclick = toggle;
        document.addEventListener('keydown', (e) => { if (e.altKey && e.code === 'KeyD') { e.preventDefault(); toggle(); } });

        const mk = (tag, text, parent) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (parent) parent.appendChild(el); return el; };
        mk('b', 'GeoFS Defensive AI v4.2', panel);
        mk('div', 'Missile aliases include designations and common/NATO names. IR: flares; radar: chaffs; unspecified IR/radar variants: both; beam/passive: evading. Chat roleplay only, not a guarantee of defeating a missile.', panel);
        const checks = [];
        [['enabled', 'Enable addon'], ['autoChat', 'Auto chat replies'], ['hud', 'HUD banners'], ['sounds', 'Sounds']].forEach(([k, label]) => {
            const l = mk('label', null, panel); const c = mk('input', null, l); c.type = 'checkbox';
            c.onchange = () => { settings.set(k, c.checked); if (k === 'enabled') paint(); if (k === 'hud' && !c.checked) hud.clear(); };
            l.appendChild(document.createTextNode(' ' + label)); checks.push([k, c]);
        });
        mk('h4', 'Detected Aliases', panel);
        const detBox = mk('div', null, panel);
        mk('h4', 'Custom Aliases', panel);
        const rowsBox = mk('div', null, panel);
        const actions = mk('div', null, panel);
        const rows = [];
        const addRow = (val) => {
            const r = mk('div', null, rowsBox); const i = mk('input', null, r); i.type = 'text'; i.value = val || '';
            const rm = mk('button', 'Remove', r);
            const rec = { r, i }; rows.push(rec);
            rm.onclick = () => { rowsBox.removeChild(r); rows.splice(rows.indexOf(rec), 1); save(); };
            return i;
        };
        const save = () => {
            settings.set('customAliases', rows.map(x => x.i.value.trim()).filter(Boolean));
            aliases.rebuild(); sync(true);
        };
        const bAdd = mk('button', 'Add', actions); bAdd.onclick = () => addRow('').focus();
        const bImp = mk('button', 'Import', actions);
        const bSave = mk('button', 'Save', actions); bSave.onclick = save;
        const impBox = mk('div', null, panel); impBox.style.display = 'none';
        const ta = mk('textarea', null, impBox); ta.rows = 3; ta.style.cssText = 'width:100%;box-sizing:border-box'; ta.placeholder = 'One per line, comma separated, or JSON array';
        const bApply = mk('button', 'Apply import', impBox);
        bImp.onclick = () => { impBox.style.display = impBox.style.display === 'none' ? 'block' : 'none'; };
        bApply.onclick = () => {
            let list = [];
            try { const j = JSON.parse(ta.value); if (Array.isArray(j)) list = j.map(String); } catch (e) { list = ta.value.split(/[\n,;]+/); }
            list.map(s => s.trim()).filter(Boolean).forEach(s => addRow(s));
            ta.value = ''; impBox.style.display = 'none'; save();
        };
        const bDbg = mk('button', 'Debug panel', panel);
        const dbg = mk('pre', '', panel); dbg.style.display = 'none';
        bDbg.onclick = () => { dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none'; sync(); };

        function debugText() {
            const i = aliases.identity.info;
            const top = state.engagements.filter(e => e.phase === 'LOCKED' || e.phase === 'LAUNCHED')[0];
            const L = [];
            L.push('Detection status: ' + aliases.status);
            L.push('Detected callsign: ' + (i.callsign || '-'));
            L.push('Detected username: ' + (i.username || '-'));
            L.push('Detected aliases: ' + (aliases.detected.join(', ') || '-'));
            L.push('Custom aliases: ' + (aliases.custom.join(', ') || '-'));
            L.push('Active aliases: ' + (aliases.active.join(', ') || '-'));
            L.push('Auto chat: ' + (ctx.monitor ? ctx.monitor.lastSendStatus : 'Not started'));
            L.push('Threat state: ' + (top ? top.phase + ' ' + (top.weapon || '?') + ' (' + top.attackerName + ')' : 'NONE'));
            L.push('Threat buffer:');
            state.engagements.slice(-6).forEach(e => L.push('  #' + e.id + ' ' + e.attackerName + ' ' + (e.weapon || '?') + ' ' + e.phase));
            L.push('Last messages:');
            detector.last.slice(-8).forEach(m => L.push('  ' + m.sender + ': ' + m.text + ' [' + (m.events.join(',') || '-') + ' ' + m.score + (m.accepted ? ' OK' : '') + ']'));
            return L.join('\n');
        }
        function sync(keepRows) {
            checks.forEach(([k, c]) => { c.checked = !!settings.get(k); });
            detBox.textContent = '';
            const off = new Set((settings.get('disabledDetected') || []).map(canon));
            if (!aliases.detected.length) mk('div', aliases.stored.length ? '(none detected; using stored: ' + aliases.stored.join(', ') + ')' : '(none detected)', detBox);
            aliases.detected.forEach(a => {
                const l = mk('label', null, detBox); const c = mk('input', null, l); c.type = 'checkbox'; c.checked = !off.has(canon(a));
                c.onchange = () => {
                    const cur = new Set((settings.get('disabledDetected') || []).map(canon));
                    if (c.checked) cur.delete(canon(a)); else cur.add(canon(a));
                    settings.set('disabledDetected', Array.from(cur)); aliases.rebuild();
                };
                l.appendChild(document.createTextNode(' ' + a));
            });
            if (!keepRows) { rowsBox.textContent = ''; rows.length = 0; aliases.custom.forEach(a => addRow(a)); }
            if (dbg.style.display !== 'none') dbg.textContent = debugText();
        }
        setInterval(() => { if (panel.style.display === 'block' && dbg.style.display !== 'none') dbg.textContent = debugText(); }, 500);

        function showWizard() {
            if (document.getElementById('gdai-wizard')) return;
            const ov = mk('div', null, document.body); ov.id = 'gdai-wizard';
            const box = mk('div', null, ov);
            mk('b', 'GeoFS Defensive AI - Setup', box);
            mk('p', 'Identity could not be detected automatically.', box);
            mk('div', 'Enter Callsign:', box); const c1 = mk('input', null, box); c1.type = 'text';
            mk('div', 'Enter Additional Aliases (comma separated):', box); const c2 = mk('input', null, box); c2.type = 'text';
            const ok = mk('button', 'Save', box); ok.className = 'gdai-btn';
            const skip = mk('button', 'Skip', box); skip.className = 'gdai-btn';
            ok.onclick = () => {
                const list = [c1.value].concat(c2.value.split(/[,;\n]+/)).map(s => s.trim()).filter(Boolean);
                if (list.length) settings.set('customAliases', (settings.get('customAliases') || []).concat(list));
                settings.set('wizardDone', true); aliases.rebuild(); document.body.removeChild(ov); sync();
            };
            skip.onclick = () => { document.body.removeChild(ov); };
        }

        document.body.appendChild(wrap); document.body.appendChild(panel);
        sync();
        return { showWizard, toggle, sync };
    }

    // ---------- bootstrap ----------
    const api = { SettingsManager, IdentityDetector, AliasManager, MessageBuffer, ThreatDetector, ThreatStateManager, HUDManager, AudioManager, ChatMonitor, parseMessage, normalize, canon };
    function init() {
        const settings = new SettingsManager();
        const aliases = new AliasManager(settings, new IdentityDetector());
        const state = new ThreatStateManager(settings, aliases);
        const detector = new ThreatDetector(settings, aliases, state);
        const hud = new HUDManager(settings, state);
        const audio = new AudioManager(settings);
        const ctx = { settings, aliases, state, detector, audio, hud, ui: null };
        const monitor = new ChatMonitor(ctx);
        api.instance = Object.assign(ctx, { monitor });
        return api.instance;
    }
    window.__GeoFSDefenseAI = api;
    if (!window.__GeoFSDefenseAI_NOAUTO) {
        const go = () => { const i = init(); i.ui = buildUI(i); i.monitor.ui = i.ui; i.monitor.start(); };
        if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
    }
})();
