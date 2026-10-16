const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'geofs-defensive-ai.user.js'), 'utf8');

function setup(options = {}) {
    const sent = [];
    const notifications = [];
    const errors = [];
    let now = Date.now();
    const intervals = [];
    const intervalDelays = [];
    const chat = { sendMessage: text => sent.push(text) };
    const window = {
        __GeoFSDefenseAI_NOAUTO: true,
        geofs: { userRecord: { callsign: 't9' } },
        multiplayer: { setChatMessage(text) { this.chatMessage = text; sent.push(text); } },
        fetch: async () => ({ clone: () => ({ json: async () => ({ chatMessages: [] }) }) })
    };
    const context = vm.createContext({
        window,
        Date: class extends Date { static now() { return now; } },
        console: { error: (...args) => errors.push(args) },
        setTimeout: () => 1,
        setInterval: (callback, delay) => { intervals.push(callback); intervalDelays.push(delay); return intervals.length; },
        ...(options.document ? { document: options.document } : {})
    });
    if (options.geofs) window.geofs = options.geofs;
    vm.runInContext(source, context);
    const api = window.__GeoFSDefenseAI;
    const settings = new api.SettingsManager();
    settings.set('replyCooldownMs', 0);
    if (options.autoChat === false) settings.set('autoChat', false);
    const aliases = new api.AliasManager(settings, new api.IdentityDetector());
    const state = new api.ThreatStateManager(settings, aliases, { now: () => now });
    const detector = new api.ThreatDetector(settings, aliases, state);
    const monitor = new api.ChatMonitor({
        settings, aliases, state, detector,
        audio: { play() {} },
        hud: { render() {}, notify: text => notifications.push(text) }
    });
    const originalFetch = window.fetch;
    monitor.start();
    let ts = 0;
    function receive(text, sender = 'attacker') {
        monitor.ingest([{ cs: sender, msg: encodeURIComponent(text), ts: ++ts }]);
        monitor.queue.forEach(message => { message.t = now; });
        monitor._flush();
    }
    return {
        api, window, originalFetch, settings, aliases, state, detector, monitor, sent, receive,
        chat, notifications, errors, intervals, intervalDelays,
        advance(ms) { now += ms; }
    };
}

test('starts the chat monitor without changing the network API', () => {
    const h = setup();
    assert.equal(h.window.fetch, h.originalFetch);
    assert.equal(h.monitor.started, true);
    assert.ok(h.monitor.tickTimer);
});

test('lock aim9 on t9 then away sends flares only after launch', () => {
    const h = setup();
    h.receive('lock aim9 on t9');
    assert.equal(h.state.engagements[0].phase, 'LOCKED');
    assert.deepEqual(h.sent, []);
    h.receive('away');
    assert.equal(h.state.engagements[0].weapon, 'AIM-9');
    assert.equal(h.state.engagements[0].phase, 'COUNTERED');
    assert.deepEqual(h.sent, ['flares']);
    assert.equal(h.window.multiplayer.chatMessage, 'flares');
    assert.equal(h.detector.last[1].accepted, true);
});

test('radar lock then away preserves the chaff response', () => {
    const h = setup();
    h.receive('lock aim120 on t9');
    h.receive('away');
    assert.deepEqual(h.sent, ['chaffs']);
});

test('does not respond to another target or an unrelated sender', () => {
    const h = setup();
    h.receive('lock aim9 on t8');
    h.receive('away');
    assert.deepEqual(h.sent, []);
    h.receive('lock aim9 on t9');
    h.receive('away', 'someone else');
    assert.equal(h.state.engagements[0].phase, 'LOCKED');
    assert.deepEqual(h.sent, []);
});

test('does not respond to a bare away or a lost lock', () => {
    const h = setup();
    h.receive('away');
    assert.deepEqual(h.sent, []);
    h.receive('lock aim9 on t9');
    h.receive('lost lock');
    h.receive('away');
    assert.deepEqual(h.sent, []);
});

test('does not reuse an expired lock', () => {
    const h = setup();
    h.receive('lock aim9 on t9');
    h.advance(h.settings.get('lockLifeMs') + 1);
    h.detector.handle({ sender: 'attacker', text: 'away' });
    assert.deepEqual(h.sent, []);
});

test('respects disabled automatic replies', () => {
    const h = setup({ autoChat: false });
    h.receive('lock aim9 on t9');
    h.receive('away');
    assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
    assert.deepEqual(h.sent, []);
});

test('falls back to the legacy chat API without a global chat binding', () => {
    const h = setup();
    delete h.window.multiplayer.setChatMessage;
    h.window.chat = h.chat;
    h.receive('lock aim9 on t9');
    h.receive('away');
    assert.deepEqual(h.sent, ['flares']);
    assert.equal(h.state.engagements[0].phase, 'COUNTERED');
});

for (const failure of ['missing API', 'throwing API']) {
    test('reports ' + failure + ' without claiming a countermeasure was sent', () => {
        const h = setup();
        if (failure === 'missing API') delete h.window.multiplayer.setChatMessage;
        else h.window.multiplayer.setChatMessage = () => { throw new Error('Chat unavailable'); };
        h.receive('lock aim9 on t9');
        h.receive('away');
        assert.deepEqual(h.sent, []);
        assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
        assert.equal(h.state.engagements[0].replied, false);
        assert.equal(h.monitor.sentReplies.length, 0);
        assert.equal(h.settings.get('cooldowns').lastReply, undefined);
        assert.match(h.monitor.lastSendStatus, /^Send failed:/);
        assert.ok(h.notifications.some(text => text.startsWith('Send failed:')));
        assert.equal(h.errors.length, 1);
        h.window.multiplayer.setChatMessage = text => h.sent.push(text);
        assert.equal(h.monitor.send('flares'), true);
        assert.deepEqual(h.sent, ['flares']);
    });
}

test('cooldown suppression does not mark a new threat as countered', () => {
    const h = setup();
    h.settings.set('replyCooldownMs', 5000);
    h.settings.set('cooldowns', { lastReply: Date.now() });
    h.receive('lock aim9 on t9');
    h.receive('away');
    assert.deepEqual(h.sent, []);
    assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
    assert.equal(h.state.engagements[0].replied, false);
    assert.match(h.monitor.lastSendStatus, /cooldown/);
});

const missileCases = [
    ['R-27T/ET', 'ir', ['R-27T', 'r27et', 'R 27 ET1', 'Alamo B', 'Alamo D']],
    ['R-27R/ER', 'radar', ['R-27R', 'r27er', 'R 27 ER1', 'Alamo A', 'Alamo C']],
    ['R-27P/EP', 'passive', ['R-27P', 'r27ep', 'Alamo E', 'Alamo F']],
    ['R-23T/R-24T', 'ir', ['R23T', 'R-24T', 'Apex B', 'Apex D']],
    ['R-23R/R-24R', 'radar', ['R23R', 'R-24R', 'Apex A', 'Apex C']],
    ['R-40T/TD', 'ir', ['R40T', 'R-40TD', 'R 40 TD1', 'Acrid B']],
    ['R-40R/RD', 'radar', ['R40R', 'R-40RD', 'R 40 RD1', 'Acrid A']],
    ['R-8T/R-98T', 'ir', ['R8T', 'R-98MT', 'Anab B']],
    ['R-8R/R-98R', 'radar', ['R8R', 'R-98MR', 'Anab A']],
    ['R-3S/R-13M', 'ir', ['R3S', 'R-13M1', 'K13A', 'Atoll B', 'Atoll D']],
    ['R-3R', 'radar', ['R3R', 'Atoll C']],
    ['MICA IR', 'ir', ['MICA-IR', 'MICA NG IR', 'micair']],
    ['MICA EM/RF', 'radar', ['MICA-EM', 'MICA NG RF', 'micaradar']],
    ['R.530 IR', 'ir', ['R.530 IR', 'Matra R530IR']],
    ['R.530 radar', 'radar', ['R530EM', 'Matra R.530 radar']],
    ['AIM-4 IR', 'ir', ['AIM4B', 'AIM4C', 'AIM4D', 'AIM-4G']],
    ['AIM-4 radar', 'radar', ['AIM4A', 'AIM4E', 'AIM-4F']],
    ['AIM-9C', 'radar', ['AIM9C', 'AIM-9 C', 'Sidewinder C']],
    ['AIM-9', 'ir', ['AIM9', 'AIM-9X', 'AIM 9 L', 'AIM9X2', 'Sidewinder', 'GAR-8', 'RB24J']],
    ['AIM-7', 'radar', ['AIM7M', 'AIM-7F', 'Sparrow', 'RB71']],
    ['AIM-54', 'radar', ['AIM54C', 'Phoenix']],
    ['AIM-120', 'radar', ['AIM120C7', 'AIM-120D', 'AMRAAM', 'RB99']],
    ['AIM-132', 'ir', ['AIM132', 'ASRAAM']],
    ['AIM-174B', 'radar', ['AIM174B', 'AIM-174']],
    ['AIM-260', 'radar', ['AIM260', 'JATM']],
    ['AIM-26 Falcon', 'radar', ['AIM26B', 'Super Falcon', 'RB27']],
    ['AIM-47 Falcon', 'radar', ['AIM47A', 'GAR9']],
    ['AIM-4 Falcon', 'mixed', ['AIM4', 'Falcon']],
    ['R-60', 'ir', ['R60M', 'R-60MK', 'AA8', 'Aphid']],
    ['R-73/R-74', 'ir', ['R73', 'R-74M2', 'RVV-MD2', 'AA11', 'Archer']],
    ['R-77', 'radar', ['R77M', 'R-77-1', 'RVV-AE', 'RVV-SD', 'AA12', 'Adder']],
    ['R-33', 'radar', ['R33S', 'AA9', 'Amos']],
    ['R-37', 'radar', ['R37M', 'RVV-BD', 'AA13', 'Axehead']],
    ['R-27', 'mixed', ['R27', 'AA10', 'Alamo']],
    ['R-23/R-24', 'mixed', ['R23', 'R24', 'AA7', 'Apex']],
    ['R-40', 'mixed', ['R40', 'AA6', 'Acrid']],
    ['R-8/R-98', 'mixed', ['R8', 'R98', 'AA3', 'Anab']],
    ['K-13/R-3', 'mixed', ['K13', 'R3', 'AA2', 'Atoll']],
    ['R-4T', 'ir', ['R4T', 'R-4 T']],
    ['R-4R', 'radar', ['R4R', 'R-4 R']],
    ['R-4', 'mixed', ['R4', 'AA5', 'Ash']],
    ['K-5', 'beam', ['K5M', 'RS-2US', 'AA1', 'Alkali']],
    ['MAGIC II', 'ir', ['Magic II', 'Magic 2', 'R550 Magic II']],
    ['MAGIC', 'ir', ['Magic', 'Magic I', 'R550']],
    ['Super 530', 'radar', ['Super530D', 'Super 530F', 'Matra Super 530']],
    ['R.530', 'mixed', ['R530', 'Matra R.530']],
    ['MICA', 'mixed', ['MICA', 'MICA NG']],
    ['Meteor', 'radar', ['Meteor']],
    ['IRIS-T', 'ir', ['IRIS-T', 'irist', 'AIM2000', 'RB98']],
    ['Python', 'ir', ['Python', 'Python 3', 'Python-4', 'Python V']],
    ['Shafrir', 'ir', ['Shafrir', 'Shafrir 2']],
    ['Derby', 'radar', ['Derby', 'I-Derby ER']],
    ['PL-5A', 'radar', ['PL5A', 'PL-5 A']],
    ['PL-2/PL-5/PL-7', 'ir', ['PL2', 'PL-5B', 'PL5E', 'PL7']],
    ['PL-8', 'ir', ['PL8', 'PL-8B']],
    ['PL-9', 'ir', ['PL9C']],
    ['PL-10', 'ir', ['PL10E']],
    ['PL-11', 'radar', ['PL11B']],
    ['PL-12/SD-10', 'radar', ['PL12', 'SD-10A']],
    ['PL-15', 'radar', ['PL15E']],
    ['PL-17', 'radar', ['PL17']],
    ['TY-90', 'ir', ['TY90', 'Tian Yan 90']],
    ['AAM-1', 'ir', ['AAM1', 'Type69']],
    ['AAM-2', 'ir', ['AAM2']],
    ['AAM-3', 'ir', ['AAM3', 'Type90']],
    ['AAM-4', 'radar', ['AAM4B', 'Type99']],
    ['AAM-5', 'ir', ['AAM5B', 'Type04']],
    ['Astra', 'radar', ['Astra', 'Astra Mk II']],
    ['R-Darter', 'radar', ['R-Darter']],
    ['A-Darter', 'ir', ['A-Darter', 'Agile Darter']],
    ['V3 Kukri', 'ir', ['V3A', 'V3B', 'Kukri']],
    ['V3C Darter', 'ir', ['V3C']],
    ['Skyflash', 'radar', ['Skyflash', 'Sky Flash']],
    ['Firestreak', 'ir', ['Firestreak', 'Fire Streak']],
    ['Red Top', 'ir', ['Red Top']],
    ['SRAAM', 'ir', ['SRAAM']],
    ['Fireflash', 'beam', ['Fireflash', 'Fire Flash']],
    ['R-55', 'ir', ['R55']],
    ['AIM-95 Agile', 'ir', ['AIM95', 'Agile']],
    ['MAA-1 Piranha', 'ir', ['MAA1', 'MAA-1B', 'Piranha']],
    ['Selenia Aspide', 'radar', ['Aspide', 'Aspide 1A']],
    ['TC-1 Sky Sword I', 'ir', ['TC1', 'Sky Sword I', 'Tien Chien 1']],
    ['TC-2 Sky Sword II', 'radar', ['TC2', 'Sky Sword II', 'Tien Chien 2']],
    ['Bozdogan', 'ir', ['Bozdogan', 'BOZDO\u011eAN']],
    ['Gokdogan', 'radar', ['Gokdogan', 'G\u00d6KDO\u011eAN']],
    ['Fakour-90', 'radar', ['Fakour90']],
    ['Mistral ATAM', 'ir', ['Mistral', 'Mistral ATAM', 'ATAM']],
    ['ATAS Stinger', 'ir', ['AIM92', 'ATAS', 'Stinger']]
];

const expectedReplies = {
    ir: 'flares', radar: 'chaffs', mixed: 'flares', passive: 'evading', beam: 'evading'
};
for (const [weapon, cls, aliases] of missileCases) {
    test('detects and counters ' + weapon + ' aliases', () => {
        for (const alias of aliases) {
            const h = setup();
            h.receive('lock ' + alias + ' on t9');
            const threat = h.state.engagements[0];
            assert.ok(threat, alias);
            assert.equal(threat.weapon, weapon, alias);
            assert.equal(threat.cls, cls, alias);
            assert.deepEqual(h.sent, [], alias);
            h.receive('away');
            assert.deepEqual(h.sent, [expectedReplies[cls]], alias);
            assert.equal(threat.phase, 'COUNTERED', alias);
            const hud = h.api.HUDManager.describe(threat, h.state);
            const counter = cls === 'ir' ? 'FLARES' : cls === 'radar' ? 'CHAFFS' : cls === 'mixed' ? 'FLARES' : 'EVADING';
            assert.ok(hud.lines.includes('COUNTER: ' + counter), alias);

            const direct = setup();
            direct.receive(alias + ' away on t9');
            assert.deepEqual(direct.sent, [expectedReplies[cls]], alias + ' direct launch');

            const other = setup();
            other.receive(alias + ' away on t8');
            assert.deepEqual(other.sent, [], alias + ' other target');
        }
    });
}

test('FOX calls resolve ambiguous families without overriding explicit seekers', () => {
    for (const [text, reply] of [
        ['MICA fox 2 away on t9', 'flares'],
        ['MICA fox 3 away on t9', 'chaffs'],
        ['R27 fox 1 away on t9', 'chaffs'],
        ['R27ET fox 3 away on t9', 'flares']
    ]) {
        const h = setup();
        h.receive(text);
        assert.deepEqual(h.sent, [reply], text);
    }
});

test('missile names in ordinary chat do not trigger replies', () => {
    const h = setup();
    for (const text of ['I like Python', 'Meteor is fast', 'MICA IR', 'a sparrow flew past']) h.receive(text);
    assert.deepEqual(h.sent, []);
    assert.equal(h.state.engagements.length, 0);
});

test('does not classify a target callsign as a missile', () => {
    const h = setup();
    h.settings.set('customAliases', ['Python']);
    h.receive('away on Python');
    assert.deepEqual(h.sent, []);
    assert.equal(h.state.engagements.length, 0);
});

test('does not match longer unrelated designations', () => {
    const h = setup();
    for (const alias of ['AIM900', 'R270', 'PL100', 'A244', 'AGM122']) {
        const events = h.api.parseMessage('lock ' + alias + ' on t9');
        assert.equal(events[0].cls, 'unknown', alias);
    }
});

test('manual combined countermeasure calls handle ambiguous and known seekers', () => {
    for (const weapon of ['MICA', 'AIM9', 'AIM120']) {
        const h = setup({ autoChat: false });
        h.receive(weapon + ' away on t9');
        h.receive('flares chaffs', 't9');
        assert.equal(h.state.engagements[0].phase, 'COUNTERED', weapon);
        assert.deepEqual(h.sent, []);
    }
});

test('manual evading calls handle beam and passive guidance', () => {
    for (const weapon of ['K5', 'R27EP']) {
        const h = setup({ autoChat: false });
        h.receive(weapon + ' away on t9');
        h.receive('evading', 't9');
        assert.equal(h.state.engagements[0].phase, 'COUNTERED', weapon);
        assert.deepEqual(h.sent, []);
    }
});

test('every database designation and alias is available without network access', () => {
    const h = setup();
    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'missiledb', 'master_missile_database.json'), 'utf8'));
    for (const record of records) {
        for (const alias of [record.official_name, ...record.aliases]) {
            for (const text of [alias.toLowerCase(), alias.toUpperCase()]) {
                const events = h.api.parseMessage('lock ' + text + ' on t9');
                assert.equal(events[0].type, 'LOCK', text);
                assert.notEqual(events[0].cls, 'unknown', record.official_name + ': ' + text);
                assert.ok(events[0].weapon, text);
            }
        }
    }
});

test('database-only names and nicknames trigger appropriate replies', () => {
    for (const [alias, reply] of [
        ['Slammer', 'chaffs'], ['Winder', 'flares'], ['Gunslinger', 'chaffs'],
        ['CUDA', 'chaffs'], ['AIM-82', 'flares'], ['AIM-152', 'chaffs'],
        ['KS-172', 'chaffs'], ['PL-21', 'chaffs'], ['PL-3', 'flares'],
        ['Python 6', 'flares'], ['Astra IR', 'flares'], ['AAM-6', 'chaffs'],
        ['TianJian-1', 'flares'], ['Chinese AMRAAM', 'chaffs'],
        ['R-27ET1 export', 'flares'], ['AIM-9C Sidewinder', 'chaffs'],
        ['AA-10 Alamo B', 'flares'], ['MICA', 'flares']
    ]) {
        const h = setup();
        h.receive('lock ' + alias + ' on t9');
        assert.deepEqual(h.sent, [], alias);
        h.receive('away');
        assert.deepEqual(h.sent, [reply], alias);
        assert.equal(h.state.engagements[0].phase, 'COUNTERED', alias);
    }
});

test('longer database aliases win over generic names inside them', () => {
    const h = setup();
    for (const [alias, weapon, cls] of [
        ['Chinese AMRAAM', 'PL-12', 'radar'],
        ['Astra IR', 'Astra IR', 'ir'],
        ['Python 6', 'Python 6', 'ir'],
        ['Chinese Meteor', 'PL-15', 'radar']
    ]) {
        const event = h.api.parseMessage('lock ' + alias + ' on t9')[0];
        assert.equal(event.weapon, weapon, alias);
        assert.equal(event.cls, cls, alias);
    }
});

test('embedded lookup matches the generated database', () => {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [path.join(__dirname, 'missiledb', 'embed.cjs'), '--check']);
});

test('detects account username, callsign and multi-word account targets', () => {
    const h = setup({ geofs: { userRecord: { id: 42, callsign: 'T9', userName: 'The Very Long Pilot Name' } } });
    assert.equal(h.aliases.identity.info.username, 'The Very Long Pilot Name');
    assert.ok(h.aliases.active.includes('T9'));
    assert.ok(h.aliases.active.includes('The Very Long Pilot Name'));
    h.receive('lock aa3 on the very long pilot name');
    h.receive('away');
    assert.deepEqual(h.sent, ['flares']);
});

test('refreshes identity before processing incoming combat calls', () => {
    const h = setup({ geofs: { userRecord: {} } });
    h.window.geofs.userRecord = { id: 42, callsign: 'T9', username: 'Cosmo' };
    h.receive('lock aa3 on cosmo');
    h.receive('away');
    assert.equal(h.aliases.identity.info.username, 'Cosmo');
    assert.deepEqual(h.sent, ['flares']);
});

test('detects nested account profiles but not aircraft or API names', () => {
    const h = setup({ geofs: {
        userRecord: { account: { profile: { name: 'Cosmo', cs: 'T9' } } },
        api: { callsign: 'Wrong pilot' },
        aircraft: { instance: { pilotName: 'Aircraft author' } }
    } });
    assert.equal(h.aliases.identity.info.username, 'Cosmo');
    assert.equal(h.aliases.identity.info.callsign, 'T9');
    assert.equal(h.aliases.active.includes('Wrong pilot'), false);
    assert.equal(h.aliases.active.includes('Aircraft author'), false);
});

test('reads account callsign without icon text or another player sharing label', () => {
    const icon = { remove() { copy.textContent = 'Cosmo'; } };
    const copy = { textContent: 'Cosmoperm_identity', querySelectorAll: () => [icon] };
    const account = { getAttribute: () => null, cloneNode: () => copy };
    const document = {
        querySelector: selector => selector === '.geofs-auth .geofs-callsign' ? account : null
    };
    const h = setup({ geofs: { userRecord: {} }, document });
    assert.equal(h.aliases.identity.info.callsign, 'Cosmo');
    assert.equal(h.aliases.identity.info.username, 'Cosmo');
    assert.ok(h.aliases.active.includes('Cosmo'));
    h.receive('lock aa3 on cosmo');
    h.receive('away');
    assert.deepEqual(h.sent, ['flares']);
});

test('lowercase compact NATO aliases reach native chat', () => {
    for (const [alias, reply] of [
        ['aa3', 'flares'], ['AA3', 'flares'], ['Aa-3', 'flares'],
        ['aa 3', 'flares'], ['aa8', 'flares'], ['aa11', 'flares'], ['aa12', 'chaffs'],
        ['slammer', 'chaffs'], ['winder', 'flares'], ['aa3 fox 2', 'flares']
    ]) {
        const h = setup();
        h.receive('lock ' + alias + ' on t9');
        h.receive('away');
        assert.deepEqual(h.sent, [reply], alias);
        assert.equal(h.window.multiplayer.chatMessage, reply, alias);
    }
});

test('repeated messages with distinct GeoFS timestamps are not lost', () => {
    const h = setup();
    for (const t of [1, 2]) {
        h.window.multiplayer.chatMessage = '';
        h.monitor.ingest([{ cs: 'attacker', msg: 'lock%20aa3%20on%20t9', t: t * 2 }]);
        h.monitor._flush();
        h.monitor.ingest([{ cs: 'attacker', msg: 'away', t: t * 2 + 1 }]);
        h.monitor._flush();
    }
    assert.deepEqual(h.sent, ['flares', 'flares']);
});

test('native published chat hooks install after GeoFS loads without breaking publishing', () => {
    const h = setup();
    const published = [];
    const nativeChat = { publish(message) { assert.equal(this, nativeChat); published.push(message); return 'published'; } };
    h.window.ui = { chat: nativeChat };
    h.intervals[0]();
    const hook = nativeChat.publish;
    h.intervals[0]();
    assert.equal(nativeChat.publish, hook);
    for (const [t, msg] of [[1, 'lock aa3 on t9'], [2, 'away']]) {
        const message = { uid: 'attacker-id', cs: 'attacker', msg: encodeURIComponent(msg), t };
        assert.equal(nativeChat.publish(message), 'published');
        h.monitor.ingest([message]);
        h.monitor._flush();
    }
    assert.equal(published.length, 2);
    assert.deepEqual(h.sent, ['flares']);
});

test('recognizes own GeoFS account and multiplayer IDs, not a message ID', () => {
    const h = setup({ geofs: { userRecord: { id: 42, callsign: 'T9', username: 'Cosmo' } } });
    h.window.multiplayer.myId = 'session-1';
    h.monitor.checkIdentity();
    assert.equal(h.monitor._isOwn({ acid: 42, sender: 'old callsign' }), true);
    assert.equal(h.monitor._isOwn({ uid: 'session-1', sender: 'old callsign' }), true);
    assert.equal(h.monitor._isOwn({ id: 'session-1', uid: 'enemy', sender: 'attacker' }), false);
});

test('waits for occupied native chat slot instead of overwriting another message', () => {
    const h = setup();
    h.window.multiplayer.chatMessage = 'My manually typed message';
    h.receive('lock aa8 on t9');
    h.receive('away');
    assert.equal(h.window.multiplayer.chatMessage, 'My manually typed message');
    assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
    h.window.multiplayer.chatMessage = '';
    h.intervals[0]();
    assert.deepEqual(h.sent, ['flares']);
    assert.equal(h.state.engagements[0].phase, 'COUNTERED');
    assert.equal(h.monitor.pendingReplies.size, 0);
});

test('cooldown-delayed replies retry only inside the countermeasure window', () => {
    const h = setup();
    h.settings.set('replyCooldownMs', 5000);
    h.settings.set('cooldowns', { lastReply: h.state.now() - 4000 });
    h.receive('lock aa12 on t9');
    h.receive('away');
    assert.deepEqual(h.sent, []);
    h.advance(1250);
    h.intervals[0]();
    assert.deepEqual(h.sent, ['chaffs']);
    assert.equal(h.state.engagements[0].phase, 'COUNTERED');
});

test('pending replies expire or are discarded when auto chat is disabled', () => {
    for (const disable of [true, false]) {
        const h = setup();
        h.window.multiplayer.chatMessage = 'busy';
        h.receive('lock aa8 on t9');
        h.receive('away');
        if (disable) h.settings.set('autoChat', false);
        else h.advance(5001);
        h.window.multiplayer.chatMessage = '';
        h.intervals[0]();
        assert.deepEqual(h.sent, []);
        assert.equal(h.monitor.pendingReplies.size, 0);
    }
});

test('separate attackers are not suppressed as duplicate launch messages', () => {
    const h = setup({ autoChat: false });
    h.receive('aa8 away on t9', 'attacker one');
    h.receive('aa8 away on t9', 'attacker two');
    assert.equal(h.state.engagements.length, 2);
    assert.ok(h.state.engagements.every(e => e.phase === 'LAUNCHED'));
});

test('late chat API availability recovers without repeated failure notifications', () => {
    const h = setup();
    delete h.window.multiplayer.setChatMessage;
    h.receive('lock aa8 on t9');
    h.receive('away');
    h.intervals[0]();
    h.intervals[0]();
    assert.equal(h.errors.length, 1);
    assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
    h.window.multiplayer.setChatMessage = text => h.sent.push(text);
    h.intervals[0]();
    assert.deepEqual(h.sent, ['flares']);
    assert.equal(h.state.engagements[0].phase, 'COUNTERED');
});

test('non-AIM9 missiles accept common lock and fire phrasing', () => {
    for (const [lock, launch, reply] of [
        ['lock on t9 with aa3', 'fire', 'flares'],
        ['aa12 locked on t9', 'shoot', 'chaffs'],
        ['locking aa11 onto t9', 'missile away', 'flares'],
        ['locked r27et on t9', 'launch', 'flares'],
        ['lock mica ir on t9', 'firing', 'flares']
    ]) {
        const h = setup();
        h.receive(lock);
        assert.equal(h.state.engagements[0]?.phase, 'LOCKED', lock);
        h.receive(launch);
        assert.deepEqual(h.sent, [reply], lock + ' -> ' + launch);
    }
});

test('combined lock and launch messages send the correct countermeasure', () => {
    for (const [message, reply] of [
        ['lock aa3 on t9 away', 'flares'],
        ['aa12 locked on t9 firing', 'chaffs'],
        ['lock on t9 with iris-t and fire', 'flares']
    ]) {
        const h = setup();
        h.receive(message);
        assert.deepEqual(h.sent, [reply], message);
    }
});

test('fire and shoot with an explicit missile and target work without a lock', () => {
    for (const [message, reply] of [
        ['fire aa12 at t9', 'chaffs'],
        ['shoot mica ir on t9', 'flares'],
        ['launching meteor at t9', 'chaffs']
    ]) {
        const h = setup();
        h.receive(message);
        assert.deepEqual(h.sent, [reply], message);
    }
});

test('every database alias completes lock to launch to native countermeasure chat', () => {
    const h = setup();
    const records = JSON.parse(fs.readFileSync(path.join(__dirname, 'missiledb', 'master_missile_database.json'), 'utf8'));
    const aliases = new Set(records.flatMap(record => [record.official_name, ...record.aliases]));
    for (const alias of aliases) {
        h.state.engagements.length = 0;
        h.sent.length = 0;
        h.window.multiplayer.chatMessage = '';
        h.receive('lock ' + alias.toLowerCase() + ' on t9');
        const threat = h.state.engagements[0];
        assert.ok(threat, alias);
        assert.equal(threat.phase, 'LOCKED', alias);
        assert.deepEqual(h.sent, [], alias);
        h.receive('away');
        assert.deepEqual(h.sent, [expectedReplies[threat.cls]], alias);
        assert.equal(h.window.multiplayer.chatMessage, expectedReplies[threat.cls], alias);
        assert.equal(threat.phase, 'COUNTERED', alias);
    }
});

test('chat prerequisites are reported and recover without claiming sends', () => {
    for (const block of ['disabled chat', 'signed out']) {
        const h = setup();
        if (block === 'disabled chat') h.window.geofs.preferences = { chat: false };
        if (block === 'signed out') h.window.geofs.userRecord.role = 0;
        h.receive('lock aa12 on t9');
        h.receive('away');
        assert.deepEqual(h.sent, [], block);
        assert.match(h.monitor.lastSendStatus, /Chat (?:blocked|waiting):/, block);
        assert.equal(h.state.engagements[0].phase, 'LAUNCHED', block);
        h.window.geofs.preferences = { chat: true };
        h.window.geofs.userRecord.role = 1;
        h.intervals[0]();
        assert.deepEqual(h.sent, ['chaffs'], block);
    }
});

test('multiplayer lifecycle flags do not block a working native chat API', () => {
    for (const flags of [{ on: false }, { started: false }, { on: false, started: false }]) {
        const h = setup();
        Object.assign(h.window.multiplayer, flags);
        assert.equal(h.monitor.chatBlocker(), '');
        h.receive('lock aa12 on t9');
        h.receive('away');
        assert.deepEqual(h.sent, ['chaffs']);
        assert.equal(h.window.multiplayer.chatMessage, 'chaffs');
        assert.equal(h.state.engagements[0].phase, 'COUNTERED');
        assert.match(h.monitor.lastSendStatus, /^Queued for GeoFS chat:/);
        for (const [key, value] of Object.entries(flags)) assert.equal(h.window.multiplayer[key], value);
    }
});

test('native API rejection is surfaced and is not a countered threat', () => {
    const h = setup();
    h.window.multiplayer.setChatMessage = () => false;
    h.receive('lock aa12 on t9');
    h.receive('away');
    assert.deepEqual(h.sent, []);
    assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
    assert.match(h.monitor.lastSendStatus, /did not accept/);
    assert.equal(h.errors.length, 1);
});

test('rejected messages explain why detection did not trigger', () => {
    const h = setup();
    for (const [text, reason] of [
        ['aa12 is a missile', /No combat phrase/],
        ['lock aa12 on t8', /Target does not match/],
        ['away', /No target or matching lock/],
        ['lock xyz-missile on t9', /Missile alias not recognized/]
    ]) {
        h.receive(text);
        assert.equal(h.detector.last.at(-1).accepted, false, text);
        assert.match(h.detector.last.at(-1).reason, reason, text);
    }
    h.receive('aa12 away on t9', 't9');
    assert.match(h.detector.last.at(-1).reason, /Own message/);
    assert.deepEqual(h.sent, []);
});

test('matching callsign does not hide a different sender with explicit GeoFS IDs', () => {
    const h = setup({ geofs: { userRecord: { id: 42, callsign: 't9' } } });
    h.monitor.ingest([{ acid: 43, uid: 'enemy', cs: 't9', msg: 'fire%20aa12%20at%20t9', ts: 1 }]);
    h.monitor._flush();
    assert.deepEqual(h.sent, ['chaffs']);
});

test('settings test-chat button uses the native API and shows real queue status', () => {
    const elements = [];
    function element(tag) {
        const el = {
            tag, textContent: '', style: {}, children: [],
            classList: { add() {}, remove() {} },
            appendChild(child) { this.children.push(child); child.parentNode = this; },
            addEventListener() {}
        };
        elements.push(el);
        return el;
    }
    const document = {
        head: element('head'), body: element('body'),
        createElement: element,
        createTextNode: text => ({ textContent: text }),
        querySelector: () => null,
        addEventListener() {}
    };
    const sent = [];
    const window = {
        geofs: { userRecord: { callsign: 'T9', role: 1 }, preferences: { chat: true } },
        multiplayer: {
            on: true, started: true, chatMessage: '',
            setChatMessage(text) { this.chatMessage = text; sent.push(text); }
        }
    };
    vm.runInNewContext(source, { window, document, setInterval: () => 1, setTimeout: () => 1 });
    const button = elements.find(el => el.tag === 'button' && el.textContent === 'Send test chat: flares');
    assert.ok(button);
    const instance = window.__GeoFSDefenseAI.instance;
    instance.ui.toggle();
    button.onclick();
    assert.deepEqual(sent, ['flares']);
    assert.ok(elements.some(el => el.textContent === 'Queued for GeoFS chat: flares'));
    window.geofs.preferences.chat = false;
    button.onclick();
    assert.equal(sent.length, 1);
    assert.ok(elements.some(el => el.textContent === 'Chat blocked: enable GeoFS chat in its options'));
});

test('fresh native calls without message IDs or timestamps are not permanently deduplicated', () => {
    const h = setup();
    h.window.ui = { chat: { publish() {} } };
    h.intervals[0]();
    for (let i = 0; i < 2; i++) {
        h.window.multiplayer.chatMessage = '';
        for (const text of ['lock aa12 on t9', 'away']) {
            const message = { cs: 'attacker', uid: 'enemy', msg: encodeURIComponent(text) };
            h.window.ui.chat.publish(message);
            h.monitor.ingest([message]);
            h.monitor._flush();
        }
    }
    assert.deepEqual(h.sent, ['chaffs', 'chaffs']);
    assert.equal(h.state.engagements.length, 2);
});

test('requested gun and FOX-4 formats immediately reply evade for the player only', () => {
    for (const phrase of [
        'fox4 t9', 'fox 4 t9', 'FOX4 on t9', 'fox 4 away on t9',
        'fox4 at t9', 'guns t9', 'guns guns guns t9', 'gun t9',
        'guns on t9', 'guns guns guns on t9', 'gun at t9'
    ]) {
        const h = setup();
        h.receive(phrase);
        assert.deepEqual(h.sent, ['evade'], phrase);
        assert.equal(h.state.engagements[0].cls, 'gun', phrase);
        assert.equal(h.state.engagements[0].phase, 'COUNTERED', phrase);
        const hud = h.api.HUDManager.describe(h.state.engagements[0], h.state);
        assert.ok(hud.lines.includes('COUNTER: EVADE'), phrase);

        const other = setup();
        other.receive(phrase.replace('t9', 't8'));
        assert.deepEqual(other.sent, [], phrase + ' other target');
    }
});

test('bare FOX-4 uses the same sender lock and changes missile response to evade', () => {
    for (const phrase of ['fox4', 'fox 4', 'fox4 away', 'fox 4 away']) {
        const h = setup();
        h.receive('lock aa12 on t9');
        h.receive(phrase);
        assert.deepEqual(h.sent, ['evade'], phrase);
        const noLock = setup();
        noLock.receive(phrase);
        assert.deepEqual(noLock.sent, [], phrase + ' no target');
    }
});

test('manual evade and legacy evading both counter gun threats', () => {
    for (const counter of ['evade', 'evading']) {
        const h = setup({ autoChat: false });
        h.receive('guns guns guns t9');
        assert.equal(h.state.engagements[0].phase, 'LAUNCHED');
        h.receive(counter, 't9');
        assert.equal(h.state.engagements[0].phase, 'COUNTERED', counter);
        assert.deepEqual(h.sent, []);
    }
});

test('defense maintenance and reply retry run on a one-second tick', () => {
    const h = setup();
    assert.deepEqual(h.intervalDelays, [1000]);
    h.window.multiplayer.chatMessage = 'busy';
    h.receive('guns t9');
    assert.deepEqual(h.sent, []);
    h.window.multiplayer.chatMessage = '';
    h.advance(1000);
    h.intervals[0]();
    assert.deepEqual(h.sent, ['evade']);
    assert.equal(h.state.engagements[0].phase, 'COUNTERED');
});

test('other addon chat wrappers do not cause repeated rewrapping or duplicate processing', () => {
    const h = setup();
    let published = 0;
    h.window.ui = { chat: { publish() { published++; } } };
    h.intervals[0]();
    const defenseHook = h.window.ui.chat.publish;
    const outerHook = function (message) { return defenseHook.call(this, message); };
    h.window.ui.chat.publish = outerHook;
    for (let i = 0; i < 100; i++) h.intervals[0]();
    assert.equal(h.window.ui.chat.publish, outerHook);
    h.window.ui.chat.publish({ cs: 'enemy', msg: 'aa12%20away%20on%20t9' });
    h.monitor._flush();
    assert.equal(published, 1);
    assert.equal(h.detector.last.length, 1);
    assert.deepEqual(h.sent, ['chaffs']);
});

test('maintenance never sends network requests, reconnects, or changes MPS timing', () => {
    const h = setup();
    let networkCalls = 0;
    const forbidden = () => { networkCalls++; throw new Error('Unexpected network activity'); };
    const fetch = h.window.fetch = forbidden;
    const open = forbidden;
    h.window.XMLHttpRequest = function () {};
    h.window.XMLHttpRequest.prototype.open = open;
    Object.assign(h.window.multiplayer, {
        sendUpdate: forbidden, init: forbidden, start: forbidden,
        minUpdateDelay: 500, nextUpdateTime: 12345
    });
    h.window.ui = { chat: { publish() {} } };
    for (let i = 0; i < 120; i++) {
        h.advance(1000);
        h.intervals[0]();
    }
    assert.equal(networkCalls, 0);
    assert.equal(h.window.fetch, fetch);
    assert.equal(h.window.XMLHttpRequest.prototype.open, open);
    assert.equal(h.window.multiplayer.minUpdateDelay, 500);
    assert.equal(h.window.multiplayer.nextUpdateTime, 12345);
    assert.deepEqual(h.sent, []);
});

test('duplicate userscript execution preserves the existing instance and installs no timers', () => {
    const h = setup();
    const originalApi = h.window.__GeoFSDefenseAI;
    originalApi.instance = { monitor: h.monitor };
    let timers = 0;
    vm.runInNewContext(source, {
        window: h.window,
        setInterval() { timers++; },
        setTimeout() { timers++; }
    });
    assert.equal(h.window.__GeoFSDefenseAI, originalApi);
    assert.equal(h.window.__GeoFSDefenseAI.instance.monitor, h.monitor);
    assert.equal(timers, 0);
});

test('explicit missile variants resolve to their own countermeasure before generic family fallback', () => {
    for (const [text, reply] of [
        ['lock r27et on t9', 'flares'],
        ['lock r27er on t9', 'chaffs'],
        ['lock r27ep on t9', 'evading'],
        ['lock aa3 on t9', 'flares'],
        ['lock aa12 on t9', 'chaffs']
    ]) {
        const h = setup();
        h.receive(text);
        h.receive('away');
        assert.deepEqual(h.sent, [reply], text);
    }
});

test('shorthand lock missile target then away works for representative missiles', () => {
    for (const [alias, reply] of [
        ['aim9', 'flares'],
        ['aim7', 'chaffs'],
        ['aim120', 'chaffs'],
        ['aim4 falcon', 'flares'],
        ['r27et', 'flares'],
        ['mica ir', 'flares'],
        ['mica em', 'chaffs'],
        ['pl12', 'chaffs'],
        ['aa3', 'flares'],
        ['aa12', 'chaffs']
    ]) {
        const h = setup();
        h.receive('lock ' + alias + ' t9');
        const threat = h.state.engagements[0];
        assert.ok(threat, alias);
        assert.equal(threat.phase, 'LOCKED', alias);
        assert.deepEqual(h.sent, [], alias);
        h.receive('away');
        assert.deepEqual(h.sent, [reply], alias);
        assert.equal(threat.phase, 'COUNTERED', alias);
    }
});

test('shorthand locks preserve full targets and specific missile guidance', () => {
    for (const [text, reply] of [
        ['lock aim9 t9', 'flares'],
        ['lock aa12 t9', 'chaffs'],
        ['locked aa3 t9', 'flares'],
        ['locking r27et t9', 'flares'],
        ['lock mica ir t9', 'flares'],
        ['lock mica em t9', 'chaffs'],
        ['lock aim9c t9', 'chaffs'],
        ['lock aa12 The Very Long Pilot Name', 'chaffs']
    ]) {
        const h = setup();
        h.settings.set('customAliases', ['The Very Long Pilot Name']);
        h.receive(text);
        h.receive('away');
        assert.deepEqual(h.sent, [reply], text);
    }
    const h = setup();
    for (const text of ['lock aa12 t8', 'lock not-a-missile t9', 'lock aa12']) {
        h.receive(text);
        h.receive('away');
    }
    assert.deepEqual(h.sent, []);
    assert.equal(h.state.engagements.length, 0);
});
