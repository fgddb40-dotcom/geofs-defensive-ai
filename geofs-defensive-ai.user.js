// ==UserScript==
// @name         GeoFS Defensive AI
// @namespace    GeoFS
// @version      5.1
// @description  Combat assistant: auto identity detection, lock -> fire -> countermeasure -> hit/miss state engine, confidence scoring, HUD, settings (Alt+D)
// @match        https://www.geo-fs.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    if (window.__GeoFSDefenseAI && window.__GeoFSDefenseAI.instance) return;

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
        static empty() { return { callsign: '', username: '', display: '', pilot: '', myId: '', accountId: '', sources: [] }; }
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
                add('geofs.account', g && g.account);
                add('geofs.profile', g && g.profile);
                add('multiplayer', mp);
                add('multiplayer.user', mp && mp.user);
                add('multiplayer.userRecord', mp && mp.userRecord);
                add('multiplayer.player', mp && mp.player);
                add('multiplayer.aircraft', mp && mp.aircraft);
                if (mp && mp.myId != null && mp.users) add('multiplayer.users[myId]', mp.users[mp.myId]);
                add('window.user', w.user);
                add('window.userRecord', w.userRecord);
            } catch (e) { /* ignore */ }
            return r;
        }
        static classify(key, userLike) {
            const k = String(key).toLowerCase().replace(/[_-]/g, '');
            if (k === 'callsign' || k === 'cs') return 'callsign';
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
                const userLike = /user|player|account|profile/i.test(src);
                let keys; try { keys = Object.keys(obj).slice(0, 120); } catch (e) { return; }
                for (const k of keys) {
                    let v; try { v = obj[k]; } catch (e) { continue; }
                    const cat = IdentityDetector.classify(k, userLike);
                    const s = IdentityDetector.str(v);
                    if (cat && s && !info[cat]) { info[cat] = s; info.sources.push(cat + '<-' + src + '.' + k); }
                    else if (depth < 2 && v && typeof v === 'object' && /^(user|userrecord|player|account|profile)$/i.test(k)) scan(src + '.' + k, v, depth + 1);
                }
            };
            for (const [n, o] of this._roots()) scan(n, o, 0);
            try {
                if (typeof document !== 'undefined') {
                    const read = selector => {
                        const el = document.querySelector(selector);
                        if (!el) return '';
                        const username = el.getAttribute('data-username');
                        if (username) return IdentityDetector.str(username);
                        if ('value' in el) return IdentityDetector.str(el.value);
                        const copy = el.cloneNode(true);
                        copy.querySelectorAll('.material-icons, .material-symbols-outlined, svg').forEach(icon => icon.remove());
                        return IdentityDetector.str(copy.textContent);
                    };
                    if (!info.callsign) {
                        info.callsign = read('input[name="callsign"], #callsign') ||
                            read('.geofs-auth .geofs-callsign');
                        if (info.callsign) info.sources.push('callsign<-account DOM');
                    }
                    if (!info.username) {
                        info.username = read('.geofs-auth input[name="username"], .geofs-auth [data-username]') ||
                            read('.geofs-auth .geofs-callsign');
                        if (info.username) info.sources.push('username<-account DOM');
                    }
                }
                const mp = window.multiplayer;
                if (mp && mp.myId != null) info.myId = String(mp.myId);
                const record = window.geofs && window.geofs.userRecord;
                if (record && record.id != null && String(record.id) !== '0') info.accountId = String(record.id);
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
        // Match whole alias prefixes, including multi-word account names.
        isUser(text) {
            const words = normalize(text).split(' ').filter(Boolean);
            const limit = Math.max(0, ...this.active.map(a => normalize(a).split(' ').length));
            for (let n = Math.min(limit, words.length); n >= 1; n--) {
                if (this.canons.has(canon(words.slice(0, n).join(' ')))) return true;
            }
            return false;
        }
        // Find any whole alias inside free text; returns the matched words or ''.
        findIn(text) {
            const words = normalize(text).split(' ').filter(Boolean);
            const limit = Math.max(0, ...this.active.map(a => normalize(a).split(' ').length));
            for (let i = 0; i < words.length; i++) {
                for (let n = Math.min(limit, words.length - i); n >= 1; n--) {
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
    // BEGIN GENERATED MISSILE DATABASE
    const MISSILE_DATABASE = [
        ["AIM-4 Falcon","mixed",["aim 4","aim 4 falcon","aim 4a","aim 4b","aim 4c","aim 4d","aim 4d falcon","aim 4e","aim 4f","aim 4f falcon","aim 4g","aim 4g falcon","aim 4h","aim4","aim4 falcon","aim4a","aim4b","aim4c","aim4d","aim4d falcon","aim4dfalcon","aim4e","aim4f","aim4f falcon","aim4falcon","aim4ffalcon","aim4g","aim4g falcon","aim4gfalcon","aim4h","falcon","falcon missile","falconmissile","gar 1","gar 1d","gar 2","gar 2a","gar 2b","gar 3","gar 4","gar1","gar1d","gar2","gar2a","gar2b","gar3","gar4","hughes falcon","hughesfalcon","mighty mouse falcon","mightymousefalcon","super falcon","superfalcon"]],
        ["AIM-7 Sparrow","radar",["aam n 2","aam n 3","aam n 6","aam n 6a","aam n 6b","aam n 6c","aam n 6d","aam n 6e","aamn2","aamn3","aamn6","aamn6a","aamn6b","aamn6c","aamn6d","aamn6e","aim 7","aim 7 sparrow","aim 7a","aim 7b","aim 7c","aim 7d","aim 7e","aim 7e 2","aim 7e sparrow","aim 7f","aim 7f sparrow","aim 7h","aim 7m","aim 7m sparrow","aim 7mh","aim 7p","aim 7p sparrow","aim 7r","aim7","aim7 sparrow","aim7a","aim7b","aim7c","aim7d","aim7e","aim7e sparrow","aim7e2","aim7esparrow","aim7f","aim7f sparrow","aim7fsparrow","aim7h","aim7m","aim7m sparrow","aim7mh","aim7msparrow","aim7p","aim7p sparrow","aim7psparrow","aim7r","aim7sparrow","caa 1","caa1","essm","raytheon sparrow","raytheonsparrow","rim 7","rim7","sea sparrow","seasparrow","skyflash sparrow","skyflashsparrow","spadeadam","spar","sparrow","sparrow 7","sparrow i","sparrow ii","sparrow iii","sparrow missile","sparrow7","sparrowi","sparrowii","sparrowiii","sparrowmissile"]],
        ["AIM-9 Sidewinder","ir",["9","9 charlie","9 lima","9 mike","9 papa","9 quebec","9 romeo","9 sierra","9 xray","9b","9d","9l","9m","9p","9x","aam n 7","aamn7","aim 9","aim 9 lima","aim 9 sidewinder","aim 9b","aim 9c","aim 9d","aim 9e","aim 9g","aim 9h","aim 9j","aim 9l","aim 9l i","aim 9l i 1","aim 9l i 2","aim 9m","aim 9m 8","aim 9m 9","aim 9n","aim 9p","aim 9r","aim 9s","aim 9t","aim 9x","aim 9x 2","aim 9x block 2","aim 9x block 3","aim 9x block i","aim 9x block ii","aim 9x block iii","aim 9x sidewinder","aim9","aim9 lima","aim9 sidewinder","aim9b","aim9c","aim9d","aim9e","aim9g","aim9h","aim9j","aim9l","aim9l i","aim9l i1","aim9l i2","aim9li","aim9li1","aim9li2","aim9lima","aim9m","aim9m8","aim9m9","aim9n","aim9p","aim9r","aim9s","aim9sidewinder","aim9t","aim9x","aim9x block 2","aim9x block 3","aim9x block i","aim9x block ii","aim9x block iii","aim9x sidewinder","aim9x2","aim9xblock2","aim9xblock3","aim9xblocki","aim9xblockii","aim9xblockiii","aim9xsidewinder","atas","block ii sidewinder","blockiisidewinder","chaparral","fim 92 stinger variant aim 92","fim92 stinger variant aim92","fim92stingervariantaim92","gar 8","gar 8a","gar8","gar8a","heat seeker","heatseeker","hotshot","lima","mike","mim 72","mim72","ninecharlie","ninelima","ninemike","ninepapa","ninequebec","nineromeo","ninesierra","ninexray","rattler","side winder","siderwinder","sidewender","sidewinder","sidewinder 9","sidewinder missile","sidewinder x","sidewinder xray","sidewinder9","sidewindermissile","sidewinderx","sidewinderxray","sidey","snake","winder"]],
        ["AIM-26 Falcon","radar",["aim 26","aim 26 falcon","aim 26 super falcon","aim 26a","aim 26b","aim26","aim26 falcon","aim26 super falcon","aim26a","aim26b","aim26falcon","aim26superfalcon","falcon 26","falcon26","gar 11","gar 11 aim 26","gar 9","gar11","gar11 aim26","gar11aim26","gar9","hm 55","hm55","nuclear falcon","nuclearfalcon","super falcon 26","superfalcon26"]],
        ["AIM-47 Falcon","mixed",["aim 47","aim 47 falcon","aim 47a","aim47","aim47 falcon","aim47a","aim47falcon","falcon 47","falcon47","gar 9","gar 9 falcon","gar 9a","gar9","gar9 falcon","gar9a","gar9falcon","phoenix precursor","phoenixprecursor","yaim 47","yaim 47a","yaim47","yaim47a"]],
        ["AIM-54 Phoenix","radar",["54a","54c","aam n 10 eagle","aam n 11","aamn10 eagle","aamn10eagle","aamn11","acm","aim 54","aim 54 phoenix","aim 54a","aim 54b","aim 54c","aim 54c eccm","aim 54c sealed","aim54","aim54 phoenix","aim54a","aim54b","aim54c","aim54c eccm","aim54c sealed","aim54ceccm","aim54csealed","aim54phoenix","big buff","bigbuff","buff","eagle missile","eaglemissile","f 14 missile","f14 missile","f14missile","fox 3 phoenix","foxthreephoenix","hughes phoenix","hughesphoenix","long range phoenix","longrangephoenix","missileer missile","missileermissile","phenix","pheonix","pheonix missile","pheonixmissile","phoenix","phoenix 54","phoenix a","phoenix c","phoenix missile","phoenix54","phoenixa","phoenixc","phoenixmissile","phoneix","pucks","tomcat missile","tomcatmissile"]],
        ["AIM-82","ir",["aim 82","aim 82 dogfight","aim 82a","aim82","aim82 dogfight","aim82a","aim82dogfight","dogfight missile 82","dogfightmissile82","f 15 original dogfight missile","f15 original dogfight missile","f15originaldogfightmissile"]],
        ["AIM-95 Agile","ir",["agile","agile missile","agilemissile","aim 95","aim 95 agile","aim 95 agile missile","aim 95a","aim 95a agile","aim95","aim95 agile","aim95 agile missile","aim95a","aim95a agile","aim95aagile","aim95agile","aim95agilemissile","thrust vector agile","thrustvectoragile"]],
        ["AIM-120 AMRAAM","radar",["120","120a","120b","120c","120c5","120c7","120d","advanced medium range air to air missile","advanced mediumrange airtoair missile","advancedmediumrangeairtoairmissile","aim 120","aim 120 amraam","aim 120 er","aim 120a","aim 120b","aim 120b amraam","aim 120c","aim 120c 3","aim 120c 4","aim 120c 5","aim 120c 5 amraam","aim 120c 6","aim 120c 7","aim 120c 7 amraam","aim 120c 8","aim 120c 8 amraam","aim 120d","aim 120d 3","aim 120d 3 amraam","aim 120d 3 gen 3","aim 120d amraam","aim 120d3","aim 120e","aim 120f","aim 120g","aim120","aim120 amraam","aim120 er","aim120a","aim120amraam","aim120b","aim120b amraam","aim120bamraam","aim120c","aim120c3","aim120c4","aim120c5","aim120c5 amraam","aim120c5amraam","aim120c6","aim120c7","aim120c7 amraam","aim120c7amraam","aim120c8","aim120c8 amraam","aim120c8amraam","aim120d","aim120d amraam","aim120d3","aim120d3 amraam","aim120d3 gen 3","aim120d3amraam","aim120d3gen3","aim120damraam","aim120e","aim120er","aim120f","aim120g","amraam","amraam c","amraam c5","amraam c7","amraam d","amraam er","amraam missile","amraamc","amraamc5","amraamc7","amraamd","amraamer","amraammissile","amram","amramm","catm 120","catm120","fox 3 slammer","fox3slammer","nasams missile","nasamsmissile","nato amraam","natoamraam","raytheon amraam","raytheonamraam","scoot","scooter","slam","slammer","slammer 120","slammer missile","slammer120","slammermissile"]],
        ["AIM-132 ASRAAM","ir",["advanced short range air to air missile","advanced shortrange airtoair missile","advancedshortrangeairtoairmissile","aim 132","aim 132 advanced short range air to air missile","aim 132 asraam","aim 132 block 6","aim132","aim132 advanced short range airtoair missile","aim132 asraam","aim132 block 6","aim132advancedshortrangeairtoairmissile","aim132asraam","aim132block6","asraam","asraam australia","asraam block 6","asraam block 6 sidewinder alt","asraam missile","asraam uk","asraam united kingdom","asraamaustralia","asraamblock6","asraamblock6sidewinderalt","asraammissile","asraamuk","asraamunitedkingdom","asram","cobra asraam","cobraasraam","raaf asraam","raafasraam","raf asraam","rafasraam","rocket asraam","rocketasraam"]],
        ["AIM-152 AAAM","radar",["aaam","advanced air to air missile","advanced airtoair missile","advancedairtoairmissile","aim 152","aim 152 aaam","aim 152 aaam missile","aim 152a","aim152","aim152 aaam","aim152 aaam missile","aim152a","aim152aaam","aim152aaammissile","phoenix replacement","phoenixreplacement","ramjet aaam","ramjetaaam"]],
        ["AIM-174B","radar",["174","174b","aim 174","aim 174b","aim 174b gunslinger","aim174","aim174b","aim174b gunslinger","aim174bgunslinger","air launched sm 6","airlaunched sm6","airlaunchedsm6","gunslinger","gunslinger missile","gunslingermissile","sea launched sm 6 air","sealaunched sm6 air","sealaunchedsm6air","sm 6 air launched","sm6 air","sm6 air launched","sm6air","sm6airlaunched","standard missile 6 air launched","standardmissile6airlaunched","super standard","superstandard"]],
        ["CUDA","radar",["barracuda","common hit to kill","commonhittokill","cuda","cuda aam","cuda air to air","cuda concept missile","cuda fox 3","cuda hit","cuda hit to kill","cuda hittokill","cuda missile","cuda small missile","cudaaam","cudaairtoair","cudaconceptmissile","cudafox3","cudahit","cudahittokill","cudamissile","cudasmallmissile","lockheed cuda","lockheed martin cuda","lockheedcuda","lockheedmartincuda","sacm","small advanced capabilities missile","smalladvancedcapabilitiesmissile"]],
        ["K-5","radar",["aa 1","aa 1 alkali","aa1","aa1 alkali","aa1alkali","alkali","izdeliye 51","izdeliye51","k 5","k 5m","k 5ms","k5","k5m","k5ms","rs 1","rs 1u","rs 2","rs 2 u","rs 2u","rs 2us","rs1","rs1u","rs2","rs2u","rs2us"]],
        ["K-8","mixed",["aa 3","aa 3 anab","aa3","aa3 anab","aa3anab","anab","anab ir","anab sarh","anabir","anabsarh","k 8","k 8 anab","k 8m","k 8m1","k 8mr","k 8ms","k8","k8 anab","k8anab","k8m","k8m1","k8mr","k8ms","r 8","r 8m","r 8m1","r 8mr","r 8mt","r8","r8m","r8m1","r8mr","r8mt"]],
        ["K-13","ir",["aa 2","aa 2 atoll","aa 2d advanced atoll","aa2","aa2 atoll","aa2atoll","aa2d advanced atoll","aa2dadvancedatoll","aam 1 atoll","aam1 atoll","aam1atoll","advanced atoll","advancedatoll","atoll","atoll missile","atollmissile","k 13","k 13a","k 13m","k 13r","k 13t","k13","k13a","k13m","k13r","k13t","pl 2","pl2","r 13","r 13m","r 13m1","r 13r","r 13s","r 3","r 3m","r 3r","r 3s","r13","r13m","r13m1","r13r","r13s","r3","r3m","r3r","r3s","rs 2us","rs2us","tgs 13","tgs13","vympel k 13","vympel k13","vympelk13"]],
        ["K-55","radar",["aa 1 variant k 55","aa1 variant k55","aa1variantk55","k 55","k 55 missile","k55","k55 missile","k55missile","r 55","r 55 vympel","r 55m","r55","r55 vympel","r55m","r55vympel","rs 82","rs82"]],
        ["K-60","ir",["k 60","k 60 missile","k 60 vympel","k60","k60 missile","k60 vympel","k60missile","k60vympel","r 60 predecessor","r60 predecessor","r60predecessor"]],
        ["K-74","ir",["k 74","k 74 missile","k 74 vympel","k 74m","k74","k74 missile","k74 vympel","k74m","k74missile","k74vympel","r 73 development","r 74","r73 development","r73development","r74"]],
        ["K-77","radar",["izdeliye 170","izdeliye170","k 77","k 77 missile","k 77m","k77","k77 missile","k77m","k77missile","r 77 development","r77 development","r77development"]],
        ["R-3","ir",["aa 2","aa 2 atoll","aa 2d","aa2","aa2 atoll","aa2atoll","aa2d","advanced atoll","advancedatoll","atoll","k 13","k13","r 3","r 3r","r 3s","r3","r3r","r3s"]],
        ["R-13","ir",["aa 2","aa 2 2 advanced atoll","aa 2 atoll","aa 2d","aa2","aa2 atoll","aa22 advanced atoll","aa22advancedatoll","aa2atoll","aa2d","atoll","r 13","r 13m","r 13m1","r 13r","r 13s","r13","r13m","r13m1","r13r","r13s"]],
        ["R-23","mixed",["aa 7","aa 7 apex","aa 7 apex ir","aa 7 apex sarh","aa7","aa7 apex","aa7 apex ir","aa7 apex sarh","aa7apex","aa7apexir","aa7apexsarh","apex","apex missile","apexmissile","izdeliye 340","izdeliye 340r","izdeliye 340t","izdeliye340","izdeliye340r","izdeliye340t","mig 23 apex","mig 23 missile","mig23 apex","mig23 missile","mig23apex","mig23missile","r 23","r 23m","r 23mr","r 23mt","r 23r","r 23r apex","r 23t","r 23t apex","r 24","r 24r","r 24t","r23","r23m","r23mr","r23mt","r23r","r23r apex","r23rapex","r23t","r23t apex","r23tapex","r24","r24r","r24t"]],
        ["R-24","mixed",["aa 7","aa 7 apex","aa7","aa7 apex","aa7apex","apex","izdeliye 340m","izdeliye340m","r 23 apex","r 23m","r 24","r 24 apex","r 24r","r 24r apex","r 24t","r 24t apex","r23 apex","r23apex","r23m","r24","r24 apex","r24apex","r24r","r24r apex","r24rapex","r24t","r24t apex","r24tapex"]],
        ["R-27","mixed",["27er","27et","27r","27t","aa 10","aa 10 alamo","aa 10 alamo a","aa 10 alamo b","aa 10 alamo c","aa 10 alamo d","aa 10a","aa 10b","aa 10c","aa 10d","aa 10e","aa 10f","aa10","aa10 alamo","aa10 alamo a","aa10 alamo b","aa10 alamo c","aa10 alamo d","aa10a","aa10alamo","aa10alamoa","aa10alamob","aa10alamoc","aa10alamod","aa10b","aa10c","aa10d","aa10e","aa10f","alamo","alamo a","alamo b","alamo c","alamo d","alamo e","alamo er","alamo f","alamo missile","alamoa","alamob","alamoc","alamod","alamoe","alamoer","alamof","alamomissile","izdeliye 470","izdeliye 471","izdeliye470","izdeliye471","r 27","r 27 alamo","r 27ae","r 27ea","r 27ea1","r 27em","r 27ep","r 27er","r 27er1","r 27er1 export","r 27et","r 27et1","r 27et1 export","r 27p","r 27r","r 27r1","r 27r1 export","r 27re","r 27re1","r 27t","r 27t1","r 27t1 export","r 27te","r 27te1","r27","r27 alamo","r27ae","r27alamo","r27ea","r27ea1","r27em","r27ep","r27er","r27er1","r27er1 export","r27er1export","r27et","r27et1","r27et1 export","r27et1export","r27p","r27r","r27r1","r27r1 export","r27r1export","r27re","r27re1","r27t","r27t1","r27t1 export","r27t1export","r27te","r27te1","vympel r 27","vympel r27","vympelr27"]],
        ["R-33","radar",["aa 9","aa 9 amos","aa9","aa9 amos","aa9amos","amos","amos missile","amosmissile","foxhound missile","foxhoundmissile","izdeliye 640","izdeliye640","mig 31 missile","mig31 missile","mig31missile","r 33","r 33 amos","r 33s","r33","r33 amos","r33amos","r33s"]],
        ["R-37","radar",["aa 13","aa 13 axehead","aa13","aa13 axehead","aa13axehead","arrow","axehead","izdeliye 610","izdeliye 610m","izdeliye610","izdeliye610m","k 37","k 37m","k 37m2","k37","k37m","k37m2","long range r 37","long range r37","longranger37","mig 31 missile r 37","mig 31bm missile","mig31 missile r37","mig31bm missile","mig31bmmissile","mig31missiler37","r 37","r 37 arrow","r 37m","r 37m axehead","r 37m missile","r37","r37 arrow","r37arrow","r37m","r37m axehead","r37m missile","r37maxehead","r37mmissile","rvv bd","rvv bd axehead","rvv bd export","rvv bd long range air to air missile","rvv bd vympel","rvvbd","rvvbd axehead","rvvbd export","rvvbd longrange airtoair missile","rvvbd vympel","rvvbdaxehead","rvvbdexport","rvvbdlongrangeairtoairmissile","rvvbdvympel","su 57 r 37m","su57 r37m","su57r37m","vympel r 37","vympel r37","vympelr37"]],
        ["R-40","mixed",["aa 6","aa 6 acrid","aa6","aa6 acrid","aa6acrid","acrid","acrid a","acrid b","acrid missile","acrida","acridb","acridmissile","foxbat missile","foxbatmissile","izdeliye 46","izdeliye 46t","izdeliye46","izdeliye46t","mig 25 missile","mig25 missile","mig25missile","r 40","r 40 acrid","r 40d","r 40r","r 40rd","r 40rd1","r 40t","r 40td","r 40td 1","r 40td1","r 46","r 46t","r40","r40 acrid","r40acrid","r40d","r40r","r40rd","r40rd1","r40t","r40td","r40td1","r46","r46t"]],
        ["R-60","ir",["aa 8","aa 8 aphid","aa8","aa8 aphid","aa8aphid","aphid","aphid a","aphid b","aphid missile","aphid r 60","aphid r60","aphida","aphidb","aphidmissile","aphidr60","izdeliye 62","izdeliye62","k 60","k60","r 60","r 60 aa 8","r 60 aphid","r 60m","r 60m aa 8","r 60mk","r 60mk aphid","r60","r60 aa8","r60 aphid","r60aa8","r60aphid","r60m","r60m aa8","r60maa8","r60mk","r60mk aphid","r60mkaphid","small vympel","smallvympel","vympel r 60","vympel r60","vympelr60"]],
        ["R-73","ir",["aa 11","aa 11 archer","aa11","aa11 archer","aa11archer","archer","archer aa 11","archer aa11","archer e","archer missile","archer r 73","archer r73","archer rdm2","archeraa11","archere","archermissile","archerr73","archerrdm2","helmet missile","helmetmissile","izdeliye 72","izdeliye 740","izdeliye72","izdeliye740","mig 29 missile","mig29 missile","mig29missile","r 73","r 73 archer","r 73 archer e","r 73a","r 73e","r 73em","r 73l","r 73m","r 73m1","r 73m2","r 73rdm","r 73rdm2","r 74","r 74 aa 11","r 74e","r 74m","r 74m2","r 74m2 archer","r 74me","r73","r73 archer","r73 archer e","r73a","r73archer","r73archere","r73e","r73em","r73l","r73m","r73m1","r73m2","r73rdm","r73rdm2","r74","r74 aa11","r74aa11","r74e","r74m","r74m2","r74m2 archer","r74m2archer","r74me","rvv md","rvv md export","rvv md short range air to air missile","rvv md vympel","rvv md2","rvvmd","rvvmd export","rvvmd shortrange airtoair missile","rvvmd vympel","rvvmd2","rvvmdexport","rvvmdshortrangeairtoairmissile","rvvmdvympel","su 27 missile","su27 missile","su27missile","vympel archer","vympel r 73","vympel r73","vympelarcher","vympelr73"]],
        ["R-77","radar",["aa 12","aa 12 adder","aa 12a adder","aa 12b adder","aa12","aa12 adder","aa12a adder","aa12aadder","aa12adder","aa12b adder","aa12badder","adder","adder aa12","adder missile","adder r 77","adder r77","adder rvv ae","adder rvvae","adderaa12","addermissile","adderr77","adderrvvae","amraamski","amraamski r 77","amraamski r77","amraamskir77","izdeliye 170","izdeliye 170 1","izdeliye 1701","izdeliye 180","izdeliye170","izdeliye1701","izdeliye180","k 77","k 77m","k77","k77m","r 77","r 77 1","r 77 1 export","r 77 1 rvv sd","r 77 adder","r 77 adder aa 12","r 77 pd","r 77 pd adder","r 77 rvv ae","r 77m","r 77m adder","r 77m pd","r 77m1","r 77me","r 77pd","r 77t","r77","r77 adder","r77 adder aa12","r77 pd","r77 rvvae","r771","r771 export","r771 rvvsd","r771export","r771rvvsd","r77adder","r77adderaa12","r77m","r77m adder","r77m1","r77madder","r77me","r77mpd","r77pd","r77pd adder","r77pdadder","r77rvvae","r77t","russian amraam","russianamraam","rvv ae","rvv ae d","rvv ae export","rvv ae pd","rvv ae vympel","rvv sd","rvv sd export","rvv sd vympel","rvv sdm export","rvvae","rvvae export","rvvae vympel","rvvaed","rvvaeexport","rvvaepd","rvvaevympel","rvvsd","rvvsd export","rvvsd vympel","rvvsdexport","rvvsdm export","rvvsdmexport","rvvsdvympel","vympel r 77","vympel r77","vympelr77"]],
        ["R-98","mixed",["aa 7 r 98","aa7 r98","aa7r98","mig 23 r 98","mig23 r98","mig23r98","r 23 improved","r 98","r 98 apex","r 98 izdeliye 340","r 98 missile","r 98m","r 98m1","r 98mr","r 98mr apex","r 98mt","r 98mt apex","r 98r","r 98t","r23 improved","r23improved","r98","r98 apex","r98 izdeliye 340","r98 missile","r98apex","r98izdeliye340","r98m","r98m1","r98missile","r98mr","r98mr apex","r98mrapex","r98mt","r98mt apex","r98mtapex","r98r","r98t"]],
        ["R-172","radar",["172","aam l","aam l novator","aaml","aaml novator","aamlnovator","awacs killer missile","awacskillermissile","izdeliye 172","izdeliye 172 aam l","izdeliye 172 aaml","izdeliye172","izdeliye172aaml","k 172","k172","ks 172","ks 172 aam","ks 172 aam l","ks 172 awacs killer","ks 172 novator","ks 172 novator aam l","ks172","ks172 aam","ks172 aaml","ks172 awacs killer","ks172 novator","ks172 novator aaml","ks172aam","ks172aaml","ks172awacskiller","ks172novator","ks172novatoraaml","long range 172","longrange172","novator 172","novator ks 172","novator ks172","novator r 172","novator r172","novator172","novatorks172","novatorr172","r 172","r 172 missile","r 172 novator","r172","r172 missile","r172 novator","r172missile","r172novator","slow flanker missile","slowflankermissile"]],
        ["KS-172","radar",["172","aam l","aaml","awacs killer","awacskiller","izdeliye 172","izdeliye172","k 172","k172","ks 172","ks 172 aam l","ks 172 novator","ks172","ks172 aaml","ks172 novator","ks172aaml","ks172novator","novator 172","novator aam l","novator aaml","novator ks 172","novator ks172","novator172","novatoraaml","novatorks172","r 172","r172"]],
        ["PL-1","radar",["china aa 1","china aa1","chinaaa1","chinese alkali","chinese beam rider","chinesealkali","chinesebeamrider","pen lai 1","penlai1","pi li 1","pili 1","pili1","pl 1","pl 1 sarh","pl 1a","pl 1b","pl1","pl1 sarh","pl1a","pl1b","pl1sarh"]],
        ["PL-2","ir",["china atoll","chinaatoll","chinese aa 2","chinese aa2","chinese atoll","chineseaa2","chineseatoll","pen lai 2","penlai2","pi li 2","pili2","pl 2","pl 2 atoll","pl 2a","pl 2b","pl2","pl2 atoll","pl2a","pl2atoll","pl2b","type 2 aam","type2aam"]],
        ["PL-3","ir",["chinese atoll improved","chineseatollimproved","pen lai 3","penlai3","pi li 3","pili3","pl 3","pl 3 atoll","pl3","pl3 atoll","pl3atoll"]],
        ["PL-4","radar",["pen lai 4","penlai4","pi li 4","pili4","pl 4","pl 4 sarh","pl4","pl4 sarh","pl4sarh"]],
        ["PL-5","ir",["chinese sidewinder","chinese sidewinder pl 5","chinese sidewinder pl5","chinesesidewinder","chinesesidewinderpl5","pi li 5","pili5","pl 5","pl 5 atoll","pl 5b","pl 5c","pl 5c ii","pl 5e","pl 5e export","pl 5e ii","pl 5e ii export","pl 5e2","pl 5eii","pl5","pl5 atoll","pl5atoll","pl5b","pl5c","pl5cii","pl5e","pl5e export","pl5e2","pl5eexport","pl5eii","pl5eii export","pl5eiiexport"]],
        ["PL-7","ir",["chinese magic","chinesemagic","pi li 7","pili7","pl 7","pl 7 magic","pl 7 matra","pl 7 r 550","pl7","pl7 magic","pl7 matra","pl7 r 550","pl7magic","pl7matra","pl7r550"]],
        ["PL-8","ir",["chinese python","chinese python 3","chinesepython","chinesepython3","pi li 8","pili8","pl 8","pl 8 export","pl 8a","pl 8b","pl 8b export","pl 8h","pl8","pl8 export","pl8a","pl8b","pl8b export","pl8bexport","pl8export","pl8h","python 3 china","python 3 chinese","python 3 license","python3 chinese","python3china","python3chinese","python3license"]],
        ["PL-9","ir",["chinese aphid","chineseaphid","pi li 9","pi li 9c","pili9","pili9c","pl 9","pl 9 kunlun","pl 9 tianjian","pl 9b","pl 9c","pl 9c export","pl 9l","pl9","pl9 kunlun","pl9 tianjian","pl9b","pl9c","pl9c export","pl9cexport","pl9kunlun","pl9l","pl9tianjian","tianyan 90","tianyan90","ty 90","ty 90 missile","ty90","ty90 missile","ty90missile"]],
        ["PL-10","ir",["pl 10","pl 10 airwolf","pl 10 asr","pl 10 heat seeker","pl 10 pi li 10","pl 10 shortrange","pl 10a","pl 10b","pl 10e","pl 10e asr","pl10","pl10 airwolf","pl10 asr","pl10 heat seeker","pl10 pi li 10","pl10 shortrange","pl10a","pl10airwolf","pl10asr","pl10b","pl10e","pl10e asr","pl10easr","pl10heatseeker","pl10pili10","pl10shortrange"]],
        ["PL-11","radar",["chinese aspide","chineseaspide","fd 60","fd 60 aam","fd 60 missile","fd60","fd60 aam","fd60 missile","fd60aam","fd60missile","pi li 11","pili11","pl 11","pl 11 amr","pl 11 aspide","pl 11 sparrow","pl 11a","pl 11b","pl 11c","pl 11e","pl11","pl11 amr","pl11 aspide","pl11 sparrow","pl11a","pl11amr","pl11aspide","pl11b","pl11c","pl11e","pl11sparrow"]],
        ["PL-12","radar",["chinese amraam","chineseamraam","pi li 12","pili 12","pili12","pl 12","pl 12 amraam","pl 12 arh","pl 12 fox 3","pl 12 pi li 12","pl 12 sd 10","pl 12a","pl 12b","pl 12c","pl 12d","pl 12d ramjet","pl 12e","pl 12e active","pl12","pl12 amraam","pl12 arh","pl12 fox 3","pl12 pi li 12","pl12 sd10","pl12a","pl12amraam","pl12arh","pl12b","pl12c","pl12d","pl12d ramjet","pl12dramjet","pl12e","pl12e active","pl12eactive","pl12fox3","pl12pili12","pl12sd10","sd 10 export designation","sd 10a export designation","sd10 export designation","sd10a export designation","sd10aexportdesignation","sd10exportdesignation","shan dian 10","shandian 10","shandian10"]],
        ["PL-13","radar",["pi li 13","pili13","pl 13","pl 13 aam","pl 13 long range","pl 13 ramjet","pl13","pl13 aam","pl13 long range","pl13 ramjet","pl13aam","pl13longrange","pl13ramjet"]],
        ["PL-14","radar",["pi li 14","pili14","pl 14","pl 14 aam","pl 14 ramjet","pl14","pl14 aam","pl14 ramjet","pl14aam","pl14ramjet"]],
        ["PL-15","radar",["chinese aim 120","chinese aim120","chinese amraam killer","chinese meteor","chineseaim120","chineseamraamkiller","chinesemeteor","dual pulse pl 15","dual pulse pl15","dualpulsepl15","pi li 15","pi li 15 fox 3","pili 15","pili15","pili15fox3","pl 15","pl 15 aam","pl 15 aesa","pl 15 e","pl 15 export","pl 15 pi li 15","pl 15a","pl 15b","pl 15e","pl 15e export","pl 15e export designation","pl 15e export variant","pl 15e for export","pl15","pl15 aam","pl15 aesa","pl15 e","pl15 export","pl15 pi li 15","pl15a","pl15aam","pl15aesa","pl15b","pl15e","pl15e export","pl15e export designation","pl15e export variant","pl15e for export","pl15eexport","pl15eexportdesignation","pl15eexportvariant","pl15eforexport","pl15export","pl15pili15"]],
        ["PL-16","radar",["pi li 16","pili16","pl 16","pl 16 aam","pl 16 export","pl 16 ramjet","pl16","pl16 aam","pl16 export","pl16 ramjet","pl16aam","pl16export","pl16ramjet"]],
        ["PL-17","radar",["chinese awacs killer","chineseawacskiller","j 20 awacs killer","j20 awacs killer","j20awacskiller","pi li 17","pi li 17 awacs killer","pili17","pili17awacskiller","pl 17","pl 17 aam","pl 17 aam l","pl 17 awacs killer","pl 17 hypersonic","pl 17 j 20 missile","pl 17 long range","pl xx","pl17","pl17 aam","pl17 aaml","pl17 awacs","pl17 awacs killer","pl17 hypersonic","pl17 j20 missile","pl17 long range","pl17aam","pl17aaml","pl17awacs","pl17awacskiller","pl17hypersonic","pl17j20missile","pl17longrange","plxx"]],
        ["PL-18","radar",["pl 18","pl 18 aam","pl 18 long range","pl 18 pi li 18","pl18","pl18 aam","pl18 long range","pl18 pi li 18","pl18aam","pl18longrange","pl18pili18"]],
        ["PL-19","radar",["pl 19","pl 19 aam","pl 19 awacs","pl 19 pi li 19","pl19","pl19 aam","pl19 awacs","pl19 pi li 19","pl19aam","pl19awacs","pl19pili19"]],
        ["PL-20","radar",["pi li 20","pili20","pl 20","pl 20 aam","pl 20 awacs killer","pl 20 fox 3","pl 20 pi li 20","pl 20 ramjet","pl20","pl20 aam","pl20 awacs killer","pl20 fox 3","pl20 pi li 20","pl20 ramjet","pl20aam","pl20awacskiller","pl20fox3","pl20pili20","pl20ramjet"]],
        ["PL-21","radar",["pl 21","pl 21 aam","pl 21 aesa","pl 21 pi li 21","pl 21 ramjet","pl21","pl21 aam","pl21 aesa","pl21 pi li 21","pl21 ramjet","pl21aam","pl21aesa","pl21pili21","pl21ramjet"]],
        ["SD-10","radar",["jf 17 amraam","jf 17 missile","jf17 amraam","jf17 missile","jf17amraam","jf17missile","pakistan fox 3","pakistanfox3","pl 12 export","pl 12e export","pl12 export","pl12e export","pl12eexport","pl12export","sd 10","sd 10 export","sd 10 export designation","sd 10 fox 3","sd 10 jf 17","sd 10 pakistan","sd 10 pilibi","sd 10a","sd 10a export","sd 10a pakistan","sd 10b","sd10","sd10 export","sd10 export designation","sd10 fox 3","sd10 jf17","sd10 pakistan","sd10 pilibi","sd10a","sd10a export","sd10a pakistan","sd10aexport","sd10apakistan","sd10b","sd10export","sd10exportdesignation","sd10fox3","sd10jf17","sd10pakistan","sd10pilibi","shan dian 10","shandian 10","shandian10"]],
        ["TY-90","ir",["helicopter air to air missile","helicopterairtoairmissile","pl 9 helicopter variant","pl9 helicopter variant","pl9helicoptervariant","tian yan 90","tianyan 90","tianyan90","ty 90","ty 90 helicopter","ty90","ty90 helicopter","ty90helicopter"]],
        ["TianJian-1","ir",["tian jian","tian jian 1","tianjian","tianjian 1","tianjian1","tj 1","tj1","ty 1","ty1"]],
        ["R.510","radar",["matra r 510","matra r510","matrar510","nord 5103","nord 5103 aam","nord5103","nord5103aam","r 510","r510"]],
        ["R.511","radar",["matra r 511","matra r511","matrar511","nord r 511","nordr511","r 511","r511"]],
        ["R.530","ir",["matra r 530","matra r530","matrar530","mirage f1 missile","mirage iii missile","miragef1missile","mirageiiimissile","r 530","r 530 em","r 530 ir","r 530e","r 530f","r530","r530 em","r530 ir","r530e","r530em","r530f","r530ir"]],
        ["Super 530F","radar",["matra super 530","matra super 530f","matrasuper530","matrasuper530f","mirage 2000 super 530f","mirage f1 super 530","mirage2000super530f","miragef1super530","s 530f","s530f","super 530","super 530 f","super 530 french","super 530f","super 530f 1","super 530f export","super 530f1","super530","super530 f","super530f","super530f1","super530fexport","super530french"]],
        ["Super 530D","radar",["matra super 530d","matrasuper530d","mirage 2000 super 530d","mirage2000super530d","s 530d","s530d","super 530 d","super 530d","super 530d doppler","super 530d mirage 2000","super530 d","super530d","super530ddoppler","super530dmirage2000"]],
        ["Magic I","ir",["magic","magic 1","magic 550","magic i","magic r550","magic1","magic550","magici","magicr550","magik","majic","matra magic","matra r 550","matra r550","matramagic","matrar550","mirage magic","miragemagic","r 550","r 550 magic","r 550 magic 1","r 550 magic i","r550","r550 magic","r550magic","r550magic1","r550magici"]],
        ["Magic II","ir",["magic 2","magic 2 r550","magic ii","magic r550 ii","magic2","magic2r550","magicii","magicr550ii","magik 2","magik2","majic 2","majic2","matra magic 2","matra magic ii","matramagic2","matramagicii","mirage 2000 magic 2","mirage2000magic2","r 550 magic 2","r 550 magic ii","r550 magic 2","r550magic2","r550magicii"]],
        ["MICA IR","ir",["mica","mica 2","mica fox 2","mica infrared","mica ir","mica ir export","mica ir fox 2","mica ir rf","mica missile","mica ng","mica ng ir","mica2","micafox2","micainfrared","micair","micair export","micairexport","micairfox2","micairrf","micamissile","micang","micangir","mirage 2000 mica","mirage2000mica","missile d interception de combat et d autodefense","missile d interception et de combat aerien","missiledinterceptiondecombatetdautodefense","missiledinterceptionetdecombataerien","rafale mica","rafale mica ir","rafalemica","rafalemicair"]],
        ["MICA EM","radar",["mica","mica 1","mica active radar","mica em","mica em export","mica em fox 3","mica fox 3","mica missile em","mica ng","mica ng em","mica rf","mica1","micaactiveradar","micaem","micaem export","micaemexport","micaemfox3","micafox3","micamissileem","micang","micangem","micarf","mirage 2000 mica em","mirage2000micaem","rafale mica","rafale mica em","rafalemica","rafalemicaem","vl mica","vlmica"]],
        ["Meteor","radar",["beyond visual range air to air missile","beyond visual range airtoair missile","beyondvisualrangeairtoairmissile","bvraam","mbda meteor","mbdameteor","meteo","meteor","meteor 2","meteor air to air","meteor air to air missile","meteor airtoair missile","meteor arh","meteor block 2","meteor bvraam","meteor bvraam export","meteor er","meteor eurofighter","meteor f 35","meteor f35","meteor fox 3","meteor gripen","meteor kill","meteor missile","meteor rafale","meteor ramjet","meteor typhoon","meteor2","meteorairtoair","meteorairtoairmissile","meteorarh","meteorblock2","meteorbvraam","meteorbvraamexport","meteorer","meteoreurofighter","meteorf35","meteorfox3","meteorgripen","meteorkill","meteormissile","meteorrafale","meteorramjet","meteortyphoon","metor"]],
        ["IRIS-T","ir",["eurofighter iris t","eurofighter irist","eurofighteririst","infra red imaging system tail","infra red imaging system tail thrust vector controlled","infrared imaging system tail thrust vector controlled","infraredimagingsystemtail","infraredimagingsystemtailthrustvectorcontrolled","iris","iris t","iris t air to air","iris t air to air missile","iris t block 2","iris t export","iris t hd","iris t missile","iris t sl","iris t slm","iris t sls","iris t slx","iris t typhoon","iris tee","irist","irist air to air","irist airtoair missile","irist block 2","irist export","irist hd","irist sl","irist slm","irist sls","irist slx","irist typhoon","iristairtoair","iristairtoairmissile","iristblock2","iristee","iristexport","iristhd","iristmissile","iristsl","iristslm","iristsls","iristslx","iristtyphoon"]],
        ["Skyflash","radar",["bae skyflash","baeskyflash","sky flash","skyflash","skyflash 2","skyflash f 4","skyflash f3","skyflash f4","skyflash mbda","skyflash missile","skyflash mk2","skyflash phantom","skyflash supertemp","skyflash tornado","skyflash tornado f3","skyflash2","skyflashf3","skyflashf4","skyflashmbda","skyflashmissile","skyflashmk2","skyflashphantom","skyflashsupertemp","skyflashtornado","skyflashtornadof3","sparrow skyflash","sparrowskyflash","super temp","supertemp"]],
        ["Aspide","radar",["alenia aspide","aleniaaspide","aspid","aspide","aspide 1","aspide 1a","aspide 2","aspide 2000","aspide aster","aspide f 104s","aspide f 16 italy","aspide f104s","aspide f16 italy","aspide fox 1","aspide italian sparrow","aspide missile","aspide mk 1","aspide mk 2","aspide mk1","aspide mk2","aspide sarh","aspide spada","aspide1","aspide1a","aspide2","aspide2000","aspideaster","aspidef104s","aspidef16italy","aspidefox1","aspideitaliansparrow","aspidemissile","aspidemk1","aspidemk2","aspidesarh","aspidespada","italian sparrow","italiansparrow","selenia aspide","seleniaaspide","spada aspide","spadaaspide"]],
        ["Shafrir 1","ir",["israeli sidewinder","israelisidewinder","rafael shafrir","rafael shafrir 1","rafaelshafrir","rafaelshafrir1","shafir","shafrir","shafrir 1","shafrir 1 missile","shafrir i","shafrir israeli","shafrir missile","shafrir mk 1","shafrir mk1","shafrir1","shafrir1missile","shafriri","shafririsraeli","shafrirmissile","shafrirmk1"]],
        ["Shafrir 2","ir",["israeli shafrir 2","israelishafrir2","rafael shafrir 2","rafaelshafrir2","shafir 2","shafir2","shafrir 2","shafrir 2 israeli","shafrir 2 missile","shafrir ii","shafrir ii rafael","shafrir mk 2","shafrir mk2","shafrir2","shafrir2israeli","shafrir2missile","shafririi","shafririirafael","shafrirmk2"]],
        ["Python 3","ir",["p3","pithon 3","pithon3","python 3","python 3 fox 2","python 3 fox2","python 3 israel","python 3 kfir","python 3 missile","python 3 rafael","python iii","python mk 3","python mk3","python3","python3 rafael","python3fox2","python3israel","python3kfir","python3missile","python3rafael","pythoniii","pythonmk3","pythonthree","pyton 3","pyton3","rafael python 3","rafaelpython3"]],
        ["Python 4","ir",["p4","pithon 4","pithon4","python 4","python 4 fox 2","python 4 hmd","python 4 israel","python 4 lavi","python 4 missile","python 4 rafael","python iv","python mk 4","python mk4","python4","python4 rafael","python4fox2","python4hmd","python4israel","python4lavi","python4missile","python4rafael","pythonfour","pythoniv","pythonmk4","pyton 4","pyton4","rafael python 4","rafaelpython4"]],
        ["Python 5","ir",["p5","pithon 5","pithon5","python 5","python 5 export","python 5 f 16i","python 5 f16i","python 5 fighter","python 5 fox 2","python 5 hmd","python 5 hotshot","python 5 iir","python 5 imaging","python 5 israel","python 5 lakam","python 5 missile","python 5 rafael","python mk 5","python mk5","python v","python5","python5 export","python5 iir","python5 rafael","python5export","python5f16i","python5fighter","python5fox2","python5hmd","python5hotshot","python5iir","python5imaging","python5israel","python5lakam","python5missile","python5rafael","pythonfive","pythonmk5","pythonv","pyton 5","pyton5","rafael python 5","rafaelpython5"]],
        ["Python 6","ir",["p6","pithon 6","pithon6","python 6","python 6 fox 2","python 6 hmd","python 6 imaging ir","python 6 israel","python 6 missile","python 6 rafael","python mk 6","python mk6","python vi","python6","python6 rafael","python6fox2","python6hmd","python6imagingir","python6israel","python6missile","python6rafael","pythonmk6","pythonsix","pythonvi","pyton 6","pyton6","rafael python 6","rafaelpython6"]],
        ["Derby","radar",["alto","alto brazil derby","alto derby","altobrazilderby","altoderby","derby","derby 4","derby aam","derby active radar","derby active radar missile","derby arh","derby block","derby block 4","derby er","derby er fox 3","derby export","derby extended range","derby f 16","derby f16","derby fox 3","derby fox3","derby gripen","derby hawk","derby lavi","derby lca","derby mirage","derby missile","derby python rafael","derby su 30","derby su30","derby surface","derby tejas","derby4","derbyaam","derbyactiveradar","derbyactiveradarmissile","derbyarh","derbyblock","derbyblock4","derbyer","derbyer fox 3","derbyerfox3","derbyexport","derbyextendedrange","derbyf16","derbyfox3","derbygripen","derbyhawk","derbylavi","derbylca","derbymirage","derbymissile","derbypythonrafael","derbysu30","derbysurface","derbytejas","r derby","rafael derby","rafaelderby","rderby"]],
        ["I-Derby ER","radar",["derby er block 2","derby er i","derby er ramjet","derbyerblock2","derbyeri","derbyerramjet","i derby","i derby er","i derby er export","i derby er extended range","i derby er fox 3","i derby er israel","i derby er rafael","i derby er ramjet","i derby extended range","i derby missile","iderby","iderby er","iderby er export","iderby er extended range","iderby er fox 3","iderby er israel","iderby er rafael","iderby er ramjet","iderby extended range","iderby missile","iderbyer","iderbyer export","iderbyerexport","iderbyerextendedrange","iderbyerfox3","iderbyerisrael","iderbyerrafael","iderbyerramjet","iderbyextendedrange","iderbymissile","spyder er","spyder er missile","spyderer","spyderermissile"]],
        ["AAM-1","ir",["aam 1","aam 1 mitsubishi","aam 1 sidewinder","aam 1 type 69","aam1","aam1 mitsubishi","aam1 sidewinder","aam1 type 69","aam1mitsubishi","aam1sidewinder","aam1type69","japanese sidewinder","japanesesidewinder","jasdf type 69","jasdftype69","mitsubishi aam 1","mitsubishi aam1","mitsubishiaam1","type 69","type 69 aam","type 69 missile","type 69 mitsubishi","type 69 sidewinder","type69","type69aam","type69missile","type69mitsubishi","type69sidewinder"]],
        ["AAM-2","ir",["aam 2","aam 2 japanese","aam 2 mitsubishi","aam 2 type 69","aam2","aam2 japanese","aam2 mitsubishi","aam2 type 69","aam2japanese","aam2mitsubishi","aam2type69","mitsubishi aam 2","mitsubishi aam2","mitsubishiaam2","type 69","type 69 aam","type 69 missile","type 69 mitsubishi","type69","type69aam","type69missile","type69mitsubishi"]],
        ["AAM-3","ir",["90","aam 3","aam 3 mitsubishi","aam 3 type 90","aam3","aam3 mitsubishi","aam3 type 90","aam3mitsubishi","aam3type90","japanese sidewinder 3","japanesesidewinder3","jasdf aam 3","jasdf aam3","jasdf type 90","jasdfaam3","jasdftype90","mitsubishi aam 3","mitsubishi aam3","mitsubishiaam3","type 90","type 90 aam","type 90 aam 3","type 90 aam3","type 90 air to air missile","type 90 missile","type 90 short range missile","type90","type90aam","type90aam3","type90airtoairmissile","type90missile","type90shortrangemissile"]],
        ["AAM-4","radar",["99","aam 4","aam 4 arh","aam 4 fox 3","aam 4 type 99","aam 4 type 99 mitsubishi","aam 4b","aam 4b aesa","aam 4b arh","aam 4b fox 3","aam 4b type 99","aam4","aam4 arh","aam4 fox 3","aam4 type 99","aam4 type 99 mitsubishi","aam4arh","aam4b","aam4b aesa","aam4b arh","aam4b fox 3","aam4b type 99","aam4baesa","aam4barh","aam4bfox3","aam4btype99","aam4fox3","aam4type99","aam4type99mitsubishi","japanese amraam","japaneseamraam","jasdf aam 4","jasdf aam4","jasdfaam4","mitsubishi aam 4","mitsubishi aam4","mitsubishiaam4","type 99","type 99 aam","type 99 aam 4","type 99 aam4","type 99 air to air","type 99 missile","type 99 mitsubishi","type99","type99aam","type99aam4","type99airtoair","type99missile","type99mitsubishi"]],
        ["AAM-5","ir",["04","aam 5","aam 5 hobs","aam 5 type 04","aam 5b","aam 5b type 04","aam5","aam5 hobs","aam5 type 04","aam5b","aam5b type 04","aam5btype04","aam5hobs","aam5type04","japanese asraam","japaneseasraam","jasdf aam 5","jasdf aam5","jasdfaam5","mitsubishi aam 5","mitsubishi aam5","mitsubishiaam5","type 04","type 04 aam","type 04 aam 5","type 04 aam5","type 04 air to air missile","type 04 airtoair missile","type 04 missile","type 04 mitsubishi","type04","type04aam","type04aam5","type04airtoairmissile","type04missile","type04mitsubishi"]],
        ["AAM-6","radar",["aam 6","aam 6 aam","aam 6 bvraam","aam 6 fox 3","aam 6 japan","aam 6 jnaam","aam 6 meteor","aam 6 ramjet","aam 6 type 99","aam6","aam6 aam","aam6 bvraam","aam6 fox 3","aam6 japan","aam6 jnaam","aam6 meteor","aam6 ramjet","aam6 type 99","aam6aam","aam6bvraam","aam6fox3","aam6japan","aam6jnaam","aam6meteor","aam6ramjet","aam6type99","j naam","japan uk meteor","japanese meteor","japanesemeteor","japanukmeteor","jasdf aam 6","jasdf aam6","jasdfaam6","jnaam","jnaam japan uk","jnaam meteor","jnaamjapanuk","jnaammeteor","joint new air to air missile","joint new airtoair missile","jointnewairtoairmissile","meteor japan","meteorjapan"]],
        ["Astra Mk1","radar",["astra","astra 1","astra arh","astra block 1","astra block i","astra bvr","astra bvraam","astra drdo","astra fox 3","astra india","astra mark 1","astra mark i","astra missile","astra mk 1","astra mk i","astra mk1","astra mk1 bvraam","astra mk1 drdo","astra mk1 fox 3","astra rafale","astra su 30","astra su 30mki","astra su30","astra su30mki","astra tejas","astra1","astraarh","astrablock1","astrablocki","astrabvr","astrabvraam","astradrdo","astrafox3","astraindia","astramark1","astramarki","astramissile","astramk1","astramk1bvraam","astramk1drdo","astramk1fox3","astramki","astrarafale","astrasu30","astrasu30mki","astratejas","indian amraam","indianamraam"]],
        ["Astra Mk2","radar",["astra 2","astra block 2","astra block ii","astra bvraam mk2","astra mark 2","astra mark ii","astra mk 2","astra mk 2 bvraam","astra mk 2 er","astra mk ii","astra mk2","astra mk2 bvraam","astra mk2 drdo","astra mk2 dual pulse","astra mk2 dual pulse motor","astra mk2 er","astra mk2 extended range","astra mk2 fox 3","astra mk2 india","astra2","astrablock2","astrablockii","astrabvraammk2","astramark2","astramarkii","astramk2","astramk2bvraam","astramk2drdo","astramk2dualpulse","astramk2dualpulsemotor","astramk2er","astramk2extendedrange","astramk2fox3","astramk2india","astramkii"]],
        ["Astra Mk3","radar",["astra 3","astra block 3","astra block iii","astra mark 3","astra mark iii","astra mk 3","astra mk 3 bvraam","astra mk 3 sfdr","astra mk iii","astra mk3","astra mk3 bvraam","astra mk3 drdo","astra mk3 er","astra mk3 extended range","astra mk3 fox 3","astra mk3 gandiva","astra mk3 india","astra mk3 long range","astra mk3 ramjet","astra mk3 sfdr","astra sfdr","astra3","astrablock3","astrablockiii","astramark3","astramarkiii","astramk3","astramk3bvraam","astramk3drdo","astramk3er","astramk3extendedrange","astramk3fox3","astramk3gandiva","astramk3india","astramk3longrange","astramk3ramjet","astramk3sfdr","astramkiii","astrasfdr","gandiva","gandiva bvraam","gandiva missile","gandivabvraam","gandivamissile"]],
        ["Astra IR","ir",["astra heat","astra infra red","astra infrared","astra ir","astra ir drdo","astra ir fox 2","astra ir imaging","astra ir india","astra ir missile","astra ir mk1","astra ir seeker","astra ir short range","astra ir sraam","astra ir tejas","astra ir wvr","astra mk1 ir","astra wvr","astra wvraam","astraheat","astrainfrared","astrair","astrairdrdo","astrairfox2","astrairimaging","astrairindia","astrairmissile","astrairmk1","astrairseeker","astrairshortrange","astrairsraam","astrairtejas","astrairwvr","astramk1ir","astrawvr","astrawvraam","indian wvr","indianwvr"]],
        ["SFDR Astra","radar",["astra mk3 sfdr","astra sfdr","astramk3sfdr","astrasfdr","gandiva sfdr","gandivasfdr","sfdr","sfdr astra","sfdr astra drdo","sfdr astra mk3","sfdr astra ramjet","sfdr bvraam","sfdr drdo","sfdr fox 3","sfdr gandiva","sfdr india","sfdr indian","sfdr missile","sfdr ramjet","sfdr ramjet india","sfdrastra","sfdrastradrdo","sfdrastramk3","sfdrastraramjet","sfdrbvraam","sfdrdrdo","sfdrfox3","sfdrgandiva","sfdrindia","sfdrindian","sfdrmissile","sfdrramjet","sfdrramjetindia","solid fuel ducted ramjet","solid fuel ducted ramjet astra","solidfuelductedramjet","solidfuelductedramjetastra"]],
        ["Bozdogan","ir",["boz","boz dogan","bozdogan","bozdogan aam","bozdogan boz","bozdogan bozdogan","bozdogan f 16 turkey","bozdogan f16 turkey","bozdogan fox 2","bozdogan gerfalcon","bozdogan hurjet","bozdogan ir","bozdogan kaan","bozdogan merlin","bozdogan missile","bozdogan roketsan","bozdogan sage","bozdogan short range","bozdogan sraam","bozdogan tubitak","bozdogan turkish","bozdogan within visual range","bozdogan wvr","bozdogan wvraam","bozdoganaam","bozdoganboz","bozdoganbozdogan","bozdoganf16turkey","bozdoganfox2","bozdogangerfalcon","bozdoganhurjet","bozdoganir","bozdogankaan","bozdoganmerlin","bozdoganmissile","bozdoganroketsan","bozdogansage","bozdoganshortrange","bozdogansraam","bozdogantubitak","bozdoganturkish","bozdoganwithinvisualrange","bozdoganwvr","bozdoganwvraam","merlin","merlin bozdogan","merlin missile","merlin wvraam","merlinbozdogan","merlinmissile","merlinwvraam"]],
        ["Gokdogan","radar",["gok dogan","gokdogan","gokdogan aam","gokdogan arh","gokdogan beyond visual range","gokdogan bvr","gokdogan bvraam","gokdogan f 16 turkey","gokdogan f16 turkey","gokdogan fox 3","gokdogan gok","gokdogan hurjet","gokdogan kaan","gokdogan kartal","gokdogan missile","gokdogan mk1","gokdogan peregrin","gokdogan peregrine","gokdogan roketsan","gokdogan sage","gokdogan tubitak","gokdogan turkish","gokdoganaam","gokdoganarh","gokdoganbeyondvisualrange","gokdoganbvr","gokdoganbvraam","gokdoganf16turkey","gokdoganfox3","gokdogangok","gokdoganhurjet","gokdogankaan","gokdogankartal","gokdoganmissile","gokdoganmk1","gokdoganperegrin","gokdoganperegrine","gokdoganroketsan","gokdogansage","gokdogantubitak","gokdoganturkish","peregrine","peregrine bvraam","peregrine gokdogan","peregrine missile","peregrinebvraam","peregrinegokdogan","peregrinemissile"]],
        ["Sky Sword I","ir",["sky sword","sky sword 1","sky sword i","sky sword i aidc","sky sword i ching kuo","sky sword i chingkuo","sky sword i csist","sky sword i f ck 1","sky sword i fck1","sky sword i fox 2","sky sword i idf","sky sword i ir","sky sword i ncsist","sky sword i taiwan","sky sword i tc 1","sky sword i tc1","sky sword i tien chien","sky sword1","skysword","skysword 1","skysword i","skysword1","skyswordi","skyswordiaidc","skyswordichingkuo","skyswordicsist","skyswordifck1","skyswordifox2","skyswordiidf","skyswordiir","skyswordincsist","skysworditaiwan","skysworditc1","skysworditienchien","tc 1","tc 1 sky sword","tc1","tc1 sky sword","tc1skysword","tien chien","tien chien 1","tien chien i","tien chien i sky sword","tienchien","tienchien 1","tienchien1","tienchieni","tienchieniskysword"]],
        ["Sky Sword II","radar",["sky sword 2","sky sword 2 active radar","sky sword ii","sky sword ii aidc","sky sword ii arh","sky sword ii ching kuo","sky sword ii chingkuo","sky sword ii csist","sky sword ii f ck 1","sky sword ii fck1","sky sword ii fox 3","sky sword ii idf","sky sword ii ncsist","sky sword ii taiwan","sky sword ii taiwan fox 3","sky sword ii tc 2","sky sword ii tc2","sky sword ii tien chien","sky sword2","skysword 2","skysword ii","skysword2","skysword2activeradar","skyswordii","skyswordiiaidc","skyswordiiarh","skyswordiichingkuo","skyswordiicsist","skyswordiifck1","skyswordiifox3","skyswordiiidf","skyswordiincsist","skyswordiitaiwan","skyswordiitaiwanfox3","skyswordiitc2","skyswordiitienchien","taiwan sky sword ii","taiwanese amraam","taiwaneseamraam","taiwanskyswordii","tc 2","tc 2 active","tc 2 arh","tc 2 sky sword","tc 2a","tc 2c","tc2","tc2 active","tc2 arh","tc2 sky sword","tc2a","tc2active","tc2arh","tc2c","tc2skysword","tien chien 2","tien chien ii","tien chien ii sky sword","tienchien 2","tienchien2","tienchienii","tienchieniiskysword"]],
        ["Kukri","ir",["kentron kukri","kentronkukri","kukri","kukri armscor","kukri cheetah","kukri cheetah c","kukri cheetah d","kukri cheetah e","kukri denel","kukri fox 2","kukri impala","kukri ir","kukri kentron","kukri mirage","kukri mirage f1","kukri mirage iii","kukri missile","kukri saaf","kukri sadf","kukri south africa","kukri v 3","kukri v3","kukri v3a","kukri v3b","kukriarmscor","kukricheetah","kukricheetahc","kukricheetahd","kukricheetahe","kukridenel","kukrifox2","kukriimpala","kukriir","kukrikentron","kukrimirage","kukrimiragef1","kukrimirageiii","kukrimissile","kukrisaaf","kukrisadf","kukrisouthafrica","kukriv3","kukriv3a","kukriv3b","v 3a","v 3b","v3 a","v3 b","v3a","v3a kukri","v3a kukri kentron","v3a kukri missile","v3akukri","v3akukrikentron","v3akukrimissile","v3b","v3b kukri","v3bkukri"]],
        ["Darter","ir",["darter","darter armscor","darter cheetah","darter cheetah c","darter cheetah d","darter cheetah e","darter denel","darter fox 2","darter impala","darter ir","darter kentron","darter mirage","darter mirage f1","darter mirage iii","darter missile","darter saaf","darter sadf","darter south africa","darter v 3","darter v3","darter v3c","darterarmscor","dartercheetah","dartercheetahc","dartercheetahd","dartercheetahe","darterdenel","darterfox2","darterimpala","darterir","darterkentron","dartermirage","dartermiragef1","dartermirageiii","dartermissile","dartersaaf","dartersadf","dartersouthafrica","darterv3","darterv3c","kentron darter","kentrondarter","v 3b","v 3c","v3 b","v3 c","v3b","v3b darter","v3b darter kentron","v3b kentron","v3bdarter","v3bdarterkentron","v3bkentron","v3c","v3c darter","v3cdarter"]],
        ["R-Darter","radar",["kentron r darter","kentron rdarter","kentronrdarter","r darter","r darter active","r darter active radar","r darter active radar homing","r darter arh","r darter armscor","r darter block 1","r darter cheetah","r darter cheetah c","r darter cheetah d","r darter cheetah e","r darter denel","r darter fox 3","r darter kentron","r darter mark 1","r darter mirage","r darter mirage f1","r darter mirage iii","r darter missile","r darter mk1","r darter radar","r darter saaf","r darter sadf","r darter south africa","r darter v 3","r darter v3","r darter v3c","r darter v3c kentron","radar darter","radar darter missile","radar guided darter","radardarter","radardartermissile","radarguideddarter","rdarter","rdarter active","rdarter active radar","rdarter active radar homing","rdarter arh","rdarter armscor","rdarter block 1","rdarter cheetah","rdarter cheetah c","rdarter cheetah d","rdarter cheetah e","rdarter denel","rdarter fox 3","rdarter kentron","rdarter mark 1","rdarter mirage","rdarter mirage f1","rdarter mirage iii","rdarter missile","rdarter mk1","rdarter radar","rdarter saaf","rdarter sadf","rdarter south africa","rdarter v3","rdarter v3c","rdarter v3c kentron","rdarteractive","rdarteractiveradar","rdarteractiveradarhoming","rdarterarh","rdarterarmscor","rdarterblock1","rdartercheetah","rdartercheetahc","rdartercheetahd","rdartercheetahe","rdarterdenel","rdarterfox3","rdarterkentron","rdartermark1","rdartermirage","rdartermiragef1","rdartermirageiii","rdartermissile","rdartermk1","rdarterradar","rdartersaaf","rdartersadf","rdartersouthafrica","rdarterv3","rdarterv3c","rdarterv3ckentron","v 3c","v3 c","v3c","v3c r darter","v3c rdarter","v3crdarter"]],
        ["A-Darter","ir",["a darter","a darter a 1m","a darter amb","a darter amb brazil","a darter amx","a darter avibras","a darter avibras brazil","a darter block 1","a darter brazil","a darter brazilian","a darter denel","a darter denel dynamics","a darter embraer","a darter embraer brazil","a darter f 5","a darter f 5m","a darter fab","a darter fab brazil","a darter fighter","a darter fox 2","a darter gripen","a darter gripen brazil","a darter gripen c","a darter gripen d","a darter gripen e","a darter gripen e f","a darter gripen f","a darter gripen ng","a darter hawk","a darter hawk mk120","a darter ir","a darter mark 1","a darter mectron","a darter mectron brazil","a darter missile","a darter mk1","a darter saaf","a darter south africa","a darter tiger","a darter tiger f 5","adarter","adarter a1m","adarter amb","adarter amb brazil","adarter amx","adarter avibras","adarter avibras brazil","adarter block 1","adarter brazil","adarter brazilian","adarter denel","adarter denel dynamics","adarter embraer","adarter embraer brazil","adarter f5","adarter f5m","adarter fab","adarter fab brazil","adarter fighter","adarter fox 2","adarter gripen","adarter gripen brazil","adarter gripen c","adarter gripen d","adarter gripen e","adarter gripen e f","adarter gripen f","adarter gripen ng","adarter hawk","adarter hawk mk120","adarter ir","adarter mark 1","adarter mectron","adarter mectron brazil","adarter missile","adarter mk1","adarter saaf","adarter south africa","adarter tiger","adarter tiger f5","adartera1m","adarteramb","adarterambbrazil","adarteramx","adarteravibras","adarteravibrasbrazil","adarterblock1","adarterbrazil","adarterbrazilian","adarterdenel","adarterdeneldynamics","adarterembraer","adarterembraerbrazil","adarterf5","adarterf5m","adarterfab","adarterfabbrazil","adarterfighter","adarterfox2","adartergripen","adartergripenbrazil","adartergripenc","adartergripend","adartergripene","adartergripenef","adartergripenf","adartergripenng","adarterhawk","adarterhawkmk120","adarterir","adartermark1","adartermectron","adartermectronbrazil","adartermissile","adartermk1","adartersaaf","adartersouthafrica","adartertiger","adartertigerf5","advanced darter","advanced darter missile","advanceddarter","advanceddartermissile","denel a darter","denel adarter","denel advanced darter","denel darter","deneladarter","deneladvanceddarter","deneldarter"]],
        ["MAA-1A Piranha","ir",["brazilian piranha","brazilian sidewinder","brazilianpiranha","braziliansidewinder","maa 1","maa 1 piranha","maa 1a","maa 1a brazil","maa 1a mectron","maa 1a piranha","maa 1a piranha missile","maa piranha","maa1","maa1 piranha","maa1a","maa1a brazil","maa1a mectron","maa1a piranha","maa1a piranha missile","maa1abrazil","maa1amectron","maa1apiranha","maa1apiranhamissile","maa1piranha","maapiranha","mectron maa 1","mectron maa 1a","mectron maa1","mectron maa1a","mectron piranha","mectronmaa1","mectronmaa1a","mectronpiranha","missil ar ar","missil ar ar nacional","missil ar ar piranha","missil arar","missil arar nacional","missil arar piranha","missilarar","missilararnacional","missilararpiranha","piranha","piranha 1","piranha 1a","piranha a","piranha a 1","piranha a1","piranha aam","piranha air to air missile","piranha amx","piranha brazil","piranha brazilian","piranha f 2000","piranha f 5","piranha f 5e","piranha f 5em","piranha f2000","piranha f5","piranha f5e","piranha f5em","piranha fab","piranha fox 2","piranha gripen","piranha i","piranha ir","piranha maa","piranha maa 1","piranha maa 1a","piranha maa1","piranha maa1a","piranha mark 1","piranha mectron","piranha mirage","piranha mirage 2000","piranha missile","piranha mk1","piranha1","piranha1a","piranhaa","piranhaa1","piranhaaam","piranhaairtoairmissile","piranhaamx","piranhabrazil","piranhabrazilian","piranhaf2000","piranhaf5","piranhaf5e","piranhaf5em","piranhafab","piranhafox2","piranhagripen","piranhai","piranhair","piranhamaa","piranhamaa1","piranhamaa1a","piranhamark1","piranhamectron","piranhamirage","piranhamirage2000","piranhamissile","piranhamk1"]],
        ["MAA-1B Piranha","ir",["brazilian piranha ii","brazilianpiranhaii","maa 1b","maa 1b brazil","maa 1b imaging","maa 1b mectron","maa 1b piranha","maa 1b piranha 2","maa 1b piranha b","maa 1b piranha ii","maa 1b piranha missile","maa1b","maa1b brazil","maa1b imaging","maa1b mectron","maa1b piranha","maa1b piranha 2","maa1b piranha b","maa1b piranha ii","maa1b piranha missile","maa1bbrazil","maa1bimaging","maa1bmectron","maa1bpiranha","maa1bpiranha2","maa1bpiranhab","maa1bpiranhaii","maa1bpiranhamissile","mectron maa 1b","mectron maa1b","mectron piranha ii","mectronmaa1b","mectronpiranhaii","missil ar ar piranha ii","missil arar piranha ii","missilararpiranhaii","piranha 1b","piranha 2","piranha b","piranha ii","piranha ii a 1m","piranha ii a1m","piranha ii amx","piranha ii brazil","piranha ii brazilian","piranha ii f 5","piranha ii f 5em","piranha ii f5","piranha ii f5em","piranha ii fab","piranha ii fox 2","piranha ii gripen","piranha ii ir","piranha ii mectron","piranha maa 1 b","piranha maa 1b","piranha maa1 b","piranha maa1b","piranha mark 2","piranha mk2","piranha1b","piranha2","piranhab","piranhaii","piranhaiia1m","piranhaiiamx","piranhaiibrazil","piranhaiibrazilian","piranhaiif5","piranhaiif5em","piranhaiifab","piranhaiifox2","piranhaiigripen","piranhaiiir","piranhaiimectron","piranhamaa1b","piranhamark2","piranhamk2"]],
        ["Fakour-90","radar",["aim 54 clone","aim54 clone","aim54clone","fakhour 90","fakhour90","fakhr 90","fakhr90","fakour","fakour 90","fakour 90 aam","fakour 90 arh","fakour 90 f 14","fakour 90 f 14 iran","fakour 90 f 14a","fakour 90 f14","fakour 90 fox 3","fakour 90 fox 3 iran","fakour 90 fox3","fakour 90 iaio","fakour 90 iran","fakour 90 iran aam","fakour 90 iran aim 54","fakour 90 iran air to air","fakour 90 iran air to air missile","fakour 90 iran missile","fakour 90 iran phoenix","fakour 90 iranian","fakour 90 iriaf","fakour 90 missile","fakour 90 phoenix","fakour 90 shahid shahriari","fakour 90 shahriari","fakour 90 tomcat","fakour90","fakour90 aam","fakour90 arh","fakour90 f14","fakour90 f14 iran","fakour90 f14a","fakour90 fox 3","fakour90 fox 3 iran","fakour90 fox3","fakour90 iaio","fakour90 iran","fakour90 iran aam","fakour90 iran aim54","fakour90 iran air to air","fakour90 iran air to air missile","fakour90 iran missile","fakour90 iran phoenix","fakour90 iranian","fakour90 iriaf","fakour90 missile","fakour90 phoenix","fakour90 shahid shahriari","fakour90 shahriari","fakour90 tomcat","fakour90aam","fakour90arh","fakour90f14","fakour90f14a","fakour90f14iran","fakour90fox3","fakour90fox3iran","fakour90iaio","fakour90iran","fakour90iranaam","fakour90iranaim54","fakour90iranairtoair","fakour90iranairtoairmissile","fakour90iranian","fakour90iranmissile","fakour90iranphoenix","fakour90iriaf","fakour90missile","fakour90phoenix","fakour90shahidshahriari","fakour90shahriari","fakour90tomcat","fakur","fakur 90","fakur90","iranian aim 54","iranian aim 54 phoenix","iranian aim54","iranian aim54 phoenix","iranian phoenix","iranianaim54","iranianaim54phoenix","iranianphoenix","phoenix clone","phoenixclone"]]
    ];
    // END GENERATED MISSILE DATABASE
    const MISSILE_ALIASES = new Map();
    let missileAliasWords = 0;
    for (const [weapon, cls, aliases] of MISSILE_DATABASE) {
        for (const alias of aliases) {
            if (!MISSILE_ALIASES.has(alias)) MISSILE_ALIASES.set(alias, []);
            MISSILE_ALIASES.get(alias).push({ weapon, cls });
            missileAliasWords = Math.max(missileAliasWords, alias.split(' ').length);
        }
    }
    const FOX_RE = /\bfox ?([1-4])\b/;
    const COUNTER = { ir: 'FLARES', radar: 'CHAFFS', mixed: 'FLARES', passive: 'EVADING', beam: 'EVADING', gun: 'EVADE', unknown: 'FLARES' };
    const REPLY = { ir: 'flares', radar: 'chaffs', mixed: 'flares', passive: 'evading', beam: 'evading', gun: 'evade' };

    function findWeapon(n) {
        const f = FOX_RE.exec(n);
        let builtIn = null;
        for (const w of WEAPONS) {
            const match = w.re.exec(n);
            if (match) { builtIn = { weapon: w.name, cls: w.cls, alias: match[0] }; break; }
        }
        let database = null;
        const words = n.split(' ');
        for (let size = Math.min(missileAliasWords, words.length); size > 0; size--) {
            for (let i = 0; i <= words.length - size; i++) {
                const alias = words.slice(i, i + size).join(' ');
                const matches = MISSILE_ALIASES.get(alias);
                if (!matches || database && database.alias.length >= alias.length) continue;
                const classes = new Set(matches.map(m => m.cls));
                database = {
                    weapon: matches.map(m => m.weapon).join(' / '),
                    cls: classes.size === 1 ? matches[0].cls : 'mixed',
                    alias
                };
            }
            if (database) break;
        }
        let found = builtIn;
        if (database && (!builtIn || database.alias.length > builtIn.alias.length)) {
            found = database;
            // Preserve explicit seeker variants even inside longer database aliases.
            const variants = WEAPONS.slice(0, WEAPONS.findIndex(w => w.name === 'AIM-9'));
            const variant = variants.find(w => w.re.test(database.alias));
            if (variant) found = { weapon: database.weapon, cls: variant.cls };
        }
        if (found) {
            const cls = found.cls === 'mixed' && f && +f[1] <= 3 ? (+f[1] === 2 ? 'ir' : 'radar') : found.cls;
            return { weapon: found.weapon, cls, fox: f ? +f[1] : null };
        }
        if (f) {
            const x = +f[1];
            return { weapon: 'FOX-' + x, cls: x === 2 ? 'ir' : x === 4 ? 'gun' : 'radar', fox: x };
        }
        return null;
    }

    function findWeaponExact(n) {
        const text = normalize(n);
        const hits = MISSILE_ALIASES.get(text);
        if (hits && hits.length) {
            let weapon = hits.map(m => m.weapon).join(' / ');
            let cls = new Set(hits.map(m => m.cls)).size === 1 ? hits[0].cls : 'mixed';
            for (const w of WEAPONS) {
                const match = w.re.exec(text);
                if (match && match[0] === text) { weapon = w.name; cls = w.cls; break; }
            }
            return { weapon, cls, fox: null };
        }
        return null;
    }

    // Parse one message into combat events.
    function parseMessage(text) {
        const n = normalize(text);
        const ev = [];
        if (!n) return ev;
        let m;
        const launchWord = /\b(away|fire|firing|fired|launch|launching|launched|shoot|shooting|shot|rifle)\b/.test(n);
        if (/\blost lock\b|\block lost\b|\bno lock\b/.test(n)) { ev.push({ type: 'LOST_LOCK' }); return ev; }
        if ((m = /\bguns?(?: guns?)*\b(?:\s+(?:(?:on|at)\s+)?(.*))?$/.exec(n))) {
            ev.push({ type: 'GUNS', target: /^(?:on|at)$/.test(m[1] || '') ? '' : m[1] || '' });
            return ev;
        }
        if ((m = /\bfox ?4\b(?:\s+(?:(?:on|at)\s+)?(.+))?$/.exec(n))) {
            const target = (m[1] || '').replace(/^(?:away|firing|fired)\b\s*(?:(?:on|at)\s+)?/, '');
            ev.push({ type: 'LAUNCH', target, weapon: 'FOX-4', cls: 'gun', fox: 4 });
            return ev;
        }
        if ((m = /\block(?:ing|ed)?\s+(?:(.*?)\s+)?(?:on|onto)\s+(.+)$/.exec(n))) {
            const after = /\b(?:with|using)\s+(.+)$/.exec(m[2]);
            const weaponText = n.slice(0, m.index) + ' ' + (m[1] || '') + ' ' + (after ? after[1] : '');
            const weapon = findWeapon(weaponText) || { weapon: null, cls: 'unknown', fox: null };
            const target = after ? m[2].slice(0, after.index).trim() : m[2];
            ev.push(Object.assign({ type: 'LOCK', target }, weapon));
            if (/\b(?:away|fire|firing|fired|launch|launching|launched|shoot|shooting|shot|rifle)$/.test(n)) {
                ev.push(Object.assign({ type: 'LAUNCH', target }, weapon));
            }
            return ev;
        }
        if ((m = /^\s*lock(?:ing|ed)?\s+(.+)$/i.exec(n))) {
            const words = m[1].split(' ').filter(Boolean);
            for (let prefix = Math.min(4, words.length); prefix >= 1; prefix--) {
                const weaponText = words.slice(0, prefix).join(' ');
                const weapon = findWeaponExact(weaponText);
                if (!weapon) continue;
                let targetWords = words.slice(prefix);
                while (targetWords.length && /^(?:on|onto|at|with|using)$/.test(targetWords[0])) targetWords.shift();
                const target = targetWords.join(' ').trim();
                ev.push(Object.assign({ type: 'LOCK', target }, weapon));
                if (/\b(?:away|fire|firing|fired|launch|launching|launched|shoot|shooting|shot|rifle)$/.test(n)) {
                    ev.push(Object.assign({ type: 'LAUNCH', target }, weapon));
                }
                return ev;
            }
        }
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
        else if (/\b(?:evade|evading)\b/.test(n)) ev.push({ type: 'COUNTER', cls: 'gun' });
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
            const rec = { t, sender, text, events: events.map(e => e.type), score: 0, accepted: false, reason: 'No combat phrase recognized' };
            this.last.push(rec);
            if (this.last.length > 15) this.last.shift();
            const att = String(sender).toLowerCase();
            for (const ev of events) {
                if (mine || ev.type === 'LOST_LOCK' || ev.type === 'HIT' || ev.type === 'MISS' || ev.type === 'COUNTER') {
                    rec.reason = mine ? 'Own message (automatic defense ignores your attacks)' : 'State update';
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
                if (named && !targetsMe) {
                    rec.reason = this.aliases.active.length ? 'Target does not match active aliases: ' + ev.target : 'No active player aliases';
                    continue;
                }
                const parts = {
                    alias: targetsMe || (!named && !!lock),
                    weapon: ev.type === 'GUNS' || (ev.cls && ev.cls !== 'unknown') || !!(lock && lock.cls !== 'unknown'),
                    phrase: true,
                    related
                };
                rec.score = Math.max(rec.score, this.score(parts));
                if (rec.score < this.s.get('confidenceMin')) {
                    rec.reason = !named && !lock ? 'No target or matching lock from this sender' :
                        !parts.weapon ? 'Missile alias not recognized' : 'Confidence below configured threshold';
                    continue;
                }
                if (ev.type === 'GUNS' || (ev.type === 'LAUNCH' && !lock)) {
                    const key = att + '|' + ev.type + '|' + (ev.cls || 'gun');
                    const prev = this.recent.get(key);
                    if (prev != null && t - prev < this.s.get('dedupeMs')) { rec.reason = 'Duplicate launch suppressed'; continue; }
                    this.recent.set(key, t);
                }
                rec.accepted = true;
                rec.reason = ev.type === 'LOCK' ? 'Lock recorded; waiting for launch' : 'Launch accepted';
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
            this.pendingReplies = new Map();
            this.hookedChats = new WeakSet();
            this.state.on('reply', (text, threat) => {
                const sent = this.send(text);
                if (!sent) this.pendingReplies.set(threat.id, { text, threat });
                return sent;
            });
            this.state.on('change', () => this.hud.render());
            this.state.on('event', (type, e) => {
                if (type === 'LOCK') this.audio.play('lock');
                else if (type === 'LAUNCH') this.audio.play(e.cls === 'mixed' ? 'radar' : e.cls);
            });
        }
        send(text) {
            const blocked = this.chatBlocker();
            if (blocked) {
                if (this.lastSendStatus !== blocked) this.hud.notify(blocked, 'orange', 6000);
                this.lastSendStatus = blocked;
                return false;
            }
            const now = Date.now();
            const cd = this.s.get('cooldowns') || {};
            if (now - (cd.lastReply || 0) < this.s.get('replyCooldownMs')) {
                this.lastSendStatus = 'Reply waiting: cooldown';
                return false;
            }
            try {
                const mp = window.multiplayer;
                const chat = window.chat;
                if (mp && typeof mp.setChatMessage === 'function') {
                    if (mp.chatMessage) {
                        this.lastSendStatus = 'Reply waiting: GeoFS chat queue is busy';
                        return false;
                    }
                    const result = mp.setChatMessage(text);
                    if (result === false || 'chatMessage' in mp && mp.chatMessage !== text) {
                        throw new Error('GeoFS did not accept the outgoing chat message.');
                    }
                }
                else if (chat && typeof chat.sendMessage === 'function') chat.sendMessage(text);
                else throw new Error('GeoFS chat API is unavailable. Wait for multiplayer to load.');
            } catch (error) {
                const status = 'Send failed: ' + String(error.message || error);
                if (this.lastSendStatus !== status) {
                    console.error('[GeoFS Defensive AI] ' + status, error);
                    this.hud.notify(status, 'orange', 6000);
                }
                this.lastSendStatus = status;
                return false;
            }
            this.s.set('cooldowns', Object.assign({}, cd, { lastReply: now }));
            this.sentReplies.push({ n: normalize(text), t: now });
            this.lastSendStatus = 'Queued for GeoFS chat: ' + text;
            return true;
        }
        chatBlocker() {
            const g = window.geofs;
            if (g && g.preferences && g.preferences.chat === false) return 'Chat blocked: enable GeoFS chat in its options';
            if (g && g.userRecord && g.userRecord.role === 0) return 'Chat blocked: sign in to GeoFS';
            return '';
        }
        flushReplies() {
            for (const [id, pending] of this.pendingReplies) {
                const e = pending.threat;
                if (!this.s.get('enabled') || !this.s.get('autoChat') || e.phase !== 'LAUNCHED' || this.state.now() >= e.deadline) {
                    this.pendingReplies.delete(id);
                    this.lastSendStatus = !this.s.get('enabled') || !this.s.get('autoChat') ? 'Pending reply cancelled: automatic defense disabled' :
                        e.replied ? 'Countermeasure already recorded' : 'Reply cancelled or expired before sending: ' + pending.text;
                    continue;
                }
                if (this.send(pending.text)) {
                    this.pendingReplies.delete(id);
                    e.replied = true;
                    this.state._setPhase(e, 'COUNTERED');
                }
            }
        }
        _isEcho(text) {
            const now = Date.now(), n = normalize(text);
            this.sentReplies = this.sentReplies.filter(r => now - r.t < 6000);
            const i = this.sentReplies.findIndex(r => r.n === n);
            if (i >= 0) { this.sentReplies.splice(i, 1); return true; }
            return false;
        }
        _isOwn(m) {
            const info = this.aliases.identity.info;
            if (info.accountId && m.acid != null) return String(m.acid) === info.accountId;
            if (info.myId && m.uid != null) return String(m.uid) === info.myId;
            const s = canon(m.sender);
            return !!s && this.aliases.ownNames().some(n => canon(n) === s);
        }
        ingest(list, source) {
            if (!Array.isArray(list)) return;
            const chat = window.ui && window.ui.chat;
            // Native publication represents a fresh message, even without an ID.
            // While hooked, do not also process its network-response copy.
            if (source !== 'published' && this.publishHook && chat && chat.publish === this.publishHook) return;
            for (const m of list) {
                if (!m || !m.msg) continue;
                let text;
                try { text = decodeURIComponent(String(m.msg).replace(/\+/g, ' ')); } catch (e) { text = String(m.msg); }
                const sender = m.cs || m.callsign || m.name || m.acid || m.id || '?';
                const key = [m.id, m.ts, m.t, m.time, m.uid, m.acid, sender, text].join('|');
                if (source !== 'published' && this.seen.has(key)) continue;
                this.seen.set(key, 1);
                if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
                this.queue.push({ id: m.id, uid: m.uid, acid: m.acid, sender: String(sender), text, t: Date.now() });
                if (this.queue.length > 500) this.queue.shift();
            }
            if (!this.timer) this.timer = setTimeout(() => this._flush(), 40);
        }
        _flush() {
            this.timer = null;
            if (!this.s.get('enabled')) { this.queue.length = 0; return; }
            this.checkIdentity();
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
        hookPublishedChat() {
            const chat = window.ui && window.ui.chat;
            if (!chat || typeof chat.publish !== 'function' || this.hookedChats.has(chat)) return;
            const original = chat.publish;
            const self = this;
            this.publishHook = function (message) {
                const result = original.apply(this, arguments);
                self.ingest([message], 'published');
                return result;
            };
            chat.publish = this.publishHook;
            this.hookedChats.add(chat);
        }
        start() {
            if (this.started) return; this.started = true;
            this.checkIdentity();
            this.s.onChange((k) => { if (k === 'customAliases' || k === 'disabledDetected') this.aliases.rebuild(); });
            this.hookPublishedChat();
            this.tickTimer = setInterval(() => {
                if (!this.s.get('enabled')) return;
                this.checkIdentity();
                this.hookPublishedChat();
                this.detector.tick();
                this.flushReplies();
            }, 1000);
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
        mk('b', 'GeoFS Defensive AI v5.1', panel);
        mk('div', 'Missile aliases include designations and common/NATO names. IR: flares; radar: chaffs; unspecified IR/radar variants: both; FOX-4/guns: evade; beam/passive: evading. Defense tick: 1 second. Chat roleplay only, not a guarantee of defeating a missile.', panel);
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
        const chatStatus = mk('div', '', panel);
        const bTest = mk('button', 'Send test chat: flares', panel);
        bTest.onclick = () => {
            if (!settings.get('enabled')) {
                hud.notify('Enable Defense AI before sending a test message.', 'orange', 4000);
                return;
            }
            const sent = ctx.monitor.send('flares');
            hud.notify(sent ? 'Test queued. Check GeoFS chat for your flares message.' : ctx.monitor.lastSendStatus, sent ? 'green' : 'orange', 6000);
            sync();
        };
        const dbg = mk('pre', '', panel); dbg.style.display = 'none';
        bDbg.onclick = () => { dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none'; sync(); };

        function debugText() {
            const i = aliases.identity.info;
            const top = state.engagements.filter(e => e.phase === 'LOCKED' || e.phase === 'LAUNCHED')[0];
            const L = [];
            L.push('Detection status: ' + aliases.status);
            L.push('Detected callsign: ' + (i.callsign || '-'));
            L.push('Detected username: ' + (i.username || '-'));
            L.push('Identity sources: ' + (i.sources.join(', ') || '-'));
            L.push('Detected aliases: ' + (aliases.detected.join(', ') || '-'));
            L.push('Custom aliases: ' + (aliases.custom.join(', ') || '-'));
            L.push('Active aliases: ' + (aliases.active.join(', ') || '-'));
            L.push('Auto chat: ' + (ctx.monitor ? ctx.monitor.lastSendStatus : 'Not started'));
            L.push('Pending replies: ' + (ctx.monitor ? ctx.monitor.pendingReplies.size : 0));
            L.push('Threat state: ' + (top ? top.phase + ' ' + (top.weapon || '?') + ' (' + top.attackerName + ')' : 'NONE'));
            L.push('Threat buffer:');
            state.engagements.slice(-6).forEach(e => L.push('  #' + e.id + ' ' + e.attackerName + ' ' + (e.weapon || '?') + ' ' + e.phase));
            L.push('Last messages:');
            detector.last.slice(-8).forEach(m => L.push('  ' + m.sender + ': ' + m.text + ' [' + (m.events.join(',') || '-') + ' ' + m.score + (m.accepted ? ' OK' : '') + '] ' + m.reason));
            return L.join('\n');
        }
        function sync(keepRows) {
            chatStatus.textContent = !settings.get('enabled') ? 'Defense AI is disabled' :
                !settings.get('autoChat') ? 'Automatic replies are disabled' :
                    ctx.monitor.chatBlocker() || ctx.monitor.lastSendStatus;
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
        setInterval(() => {
            if (panel.style.display !== 'block') return;
            chatStatus.textContent = !settings.get('enabled') ? 'Defense AI is disabled' :
                !settings.get('autoChat') ? 'Automatic replies are disabled' :
                    ctx.monitor.chatBlocker() || ctx.monitor.lastSendStatus;
            if (dbg.style.display !== 'none') dbg.textContent = debugText();
        }, 500);

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

