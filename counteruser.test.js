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
    const chat = { sendMessage: text => sent.push(text) };
    const window = {
        __GeoFSDefenseAI_NOAUTO: true,
        geofs: { userRecord: { callsign: 't9' } },
        multiplayer: { setChatMessage(text) { this.chatMessage = text; sent.push(text); } },
        fetch: async () => ({ clone: () => ({ json: async () => ({ chatMessages: [] }) }) })
    };
    const context = vm.createContext({
        window,
        console: { error: (...args) => errors.push(args) },
        setTimeout: () => 1,
        setInterval: () => 1
    });
    vm.runInContext(source, context);
    const api = window.__GeoFSDefenseAI;
    const settings = new api.SettingsManager();
    settings.set('replyCooldownMs', 0);
    if (options.autoChat === false) settings.set('autoChat', false);
    const aliases = new api.AliasManager(settings, new api.IdentityDetector());
    let now = Date.now();
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
        monitor._flush();
    }
    return {
        api, window, originalFetch, settings, state, detector, monitor, sent, receive,
        chat, notifications, errors,
        advance(ms) { now += ms; }
    };
}

test('starts the chat monitor and installs the network listener', () => {
    const h = setup();
    assert.notEqual(h.window.fetch, h.originalFetch);
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
    ir: 'flares', radar: 'chaffs', mixed: 'flares chaffs', passive: 'evading', beam: 'evading'
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
            const counter = cls === 'ir' ? 'FLARES' : cls === 'radar' ? 'CHAFFS' : cls === 'mixed' ? 'FLARES/CHAFFS' : 'EVADING';
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
