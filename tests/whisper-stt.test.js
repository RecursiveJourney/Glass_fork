const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire, isBuiltin } = require('node:module');

function load(relative, stubs = {}, messages = []) {
    const filename = path.join(__dirname, '../src/features/common', relative);
    const module = { exports: {} };
    const localRequire = createRequire(filename);
    const requireStub = id => {
        if (Object.hasOwn(stubs, id)) return stubs[id];
        if (isBuiltin(id) || id === './pcm24To16' || id === './pcm16Stats') return localRequire(id);
        throw new Error('Unexpected dependency: ' + id);
    };
    vm.runInThisContext('(function(require,module,exports,console){' +
        fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
        requireStub, module, module.exports,
        { log: (...args) => messages.push(args), warn: (...args) => messages.push(args),
            error: (...args) => messages.push(args), debug: (...args) => messages.push(['DEBUG', ...args]) });
    return module.exports;
}

function serviceHarness(run = async () => ({ stdout: '', stderr: 'usage: whisper-cli --model FNAME' })) {
    const calls = [];
    const service = load('services/whisperService.js', {
        fs: { ...fs, promises: { ...fs.promises, access: async () => {} } },
        '../utils/spawnHelper': { spawnAsync: async (...args) => { calls.push(args); return run(...args); } },
        '../config/checksums': { DOWNLOAD_CHECKSUMS: {} }
    });
    service.whisperPath = path.join(os.tmpdir(), 'glass-test-bin', 'whisper-cli.exe');
    service.modelsDir = os.tmpdir();
    service.tempDir = os.tmpdir();
    service.getPlatform = () => 'win32';
    service.checkCommand = async () => null;
    return { service, calls };
}

test('Whisper help on stderr with exit zero verifies successfully', async () => {
    const h = serviceHarness();
    assert.equal((await h.service.verifyInstallation()).success, true);
    assert.deepEqual(h.calls[0][1], ['--help']);
    assert.equal(h.calls[0][2].timeout, 10000);
    assert.equal(h.calls[0][2].windowsHide, true);
});

test('nonzero help with stdout-only warning fails execution verification', async () => {
    const h = serviceHarness(async () => { throw Object.assign(new Error('deprecated stub'), {
        code: 1, stdout: 'WARNING: deprecated', stderr: ''
    }); });
    assert.equal((await h.service.verifyInstallation()).success, false);
});

test('even a zero-exit deprecation warning is not a transcription CLI', async () => {
    const h = serviceHarness(async () => ({ stdout: 'whisper is deprecated; use whisper-cli --model', stderr: '' }));
    assert.equal((await h.service.verifyInstallation()).success, false);
});

test('existing executable is executed before reuse, without reinstalling', async () => {
    const h = serviceHarness();
    h.service.autoInstall = async () => assert.fail('healthy binary must not reinstall');
    await h.service.ensureWhisperBinary();
    assert.ok(h.calls.length >= 1);
});

test('failing existing executable triggers replacement and verifies the replacement', async () => {
    let replaced = false;
    const h = serviceHarness(async () => {
        if (!replaced) throw new Error('binary failed');
        return { stdout: '', stderr: 'usage: whisper-cli --model FNAME' };
    });
    h.service.autoInstall = async () => { replaced = true; };
    await h.service.ensureWhisperBinary();
    assert.equal(replaced, true);
    assert.ok(h.calls.length >= 2);
});

test('replacement that still fails execution is rejected', async () => {
    const h = serviceHarness(async () => { throw new Error('missing runtime DLL'); });
    h.service.autoInstall = async () => {};
    await assert.rejects(h.service.ensureWhisperBinary(), /verification|binary|DLL/i);
});

test('finder selects modern CLI names and ignores legacy stubs and streaming tools', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-whisper-finder-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, 'Release');
    fs.mkdirSync(nested);
    for (const name of ['main.exe', 'whisper.exe', 'whisper-whisper.exe', 'whisper-cli.exe',
        'whisper-cli', 'whisper-stream.exe']) fs.writeFileSync(path.join(nested, name), '');
    const h = serviceHarness();
    const found = await h.service.findWhisperExecutables(root);
    assert.deepEqual(found.map(item => path.basename(item)).sort(), ['whisper-cli', 'whisper-cli.exe']);
});

test('Windows installer preserves the CLI companion DLLs and verifies execution', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-whisper-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const calls = [];
    const service = load('services/whisperService.js', {
        '../utils/spawnHelper': { spawnAsync: async (command, args) => {
            calls.push([command, args]);
            if (command === 'powershell') {
                const destination = args.at(-1).match(/-DestinationPath\s+["']([^"']+)["']/)[1];
                const release = path.join(destination, 'Release');
                fs.mkdirSync(release, { recursive: true });
                for (const name of ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'main.exe'])
                    fs.writeFileSync(path.join(release, name), name);
                return { stdout: '', stderr: '' };
            }
            assert.equal(path.basename(command), 'whisper-cli.exe');
            assert.equal(fs.readFileSync(path.join(path.dirname(command), 'whisper.dll'), 'utf8'), 'whisper.dll');
            return { stdout: '', stderr: 'usage: whisper-cli --model FNAME' };
        } },
        '../config/checksums': { DOWNLOAD_CHECKSUMS: {} }
    });
    service.whisperPath = path.join(bin, 'whisper-cli.exe');
    service.tempDir = path.join(root, 'temp');
    service.modelsDir = path.join(root, 'models');
    fs.mkdirSync(service.tempDir);
    fs.mkdirSync(service.modelsDir);
    service.downloadWithRetry = async (_, destination) => fs.writeFileSync(destination, 'fake archive');
    await service.installWindows();
    assert.equal(fs.readFileSync(path.join(bin, 'ggml.dll'), 'utf8'), 'ggml.dll');
    assert.equal(path.basename(service.whisperPath), 'whisper-cli.exe');
    assert.ok(calls.some(([command]) => path.basename(command) === 'whisper-cli.exe'));
});

function pcmTone(frequency, samples = 24000, amplitude = 12000) {
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++)
        pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * frequency * i / 24000)), i * 2);
    return pcm;
}
function rms(pcm, trim = 128) {
    let sum = 0;
    const count = pcm.length / 2;
    for (let i = trim; i < count - trim; i++) sum += pcm.readInt16LE(i * 2) ** 2;
    return Math.sqrt(sum / (count - 2 * trim));
}

async function sessionHarness(t, spawnImpl, sessionId = 'my_test', debug = true) {
    const saved = [];
    const cleaned = [];
    const messages = [];
    const errors = [];
    const children = [];
    const fakeService = {
        ensureModelAvailable: async () => {},
        saveAudioToTemp: async pcm => { saved.push(pcm); return 'audio.wav'; },
        getWhisperPath: async () => 'whisper-cli.exe',
        getModelPath: async () => 'tiny.bin',
        cleanupTempFile: async filename => { cleaned.push(filename); }
    };
    const provider = load('ai/providers/whisper.js', {
        '../../config/config': { shouldLog: level => debug && level === 'debug' },
        child_process: { spawn: (command, args, options) => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {};
            children.push({ child, command, args, options });
            if (spawnImpl) spawnImpl(child);
            return child;
        } }
    }, messages);
    const session = new provider.WhisperSTTSession('whisper-tiny', fakeService, sessionId);
    session.on('error', error => errors.push(error));
    await session.initialize();
    clearInterval(session.processingInterval);
    t.after(() => session.close());
    return { session, saved, cleaned, messages, errors, children };
}

test('Whisper boundary converts one second of 24 kHz PCM to 16 kHz PCM', async t => {
    const h = await sessionHarness(t);
    h.session.sendRealtimeInput(pcmTone(1000));
    await h.session.processAudioChunk();
    assert.equal(h.saved[0].length, 16000 * 2);
    assert.ok(Math.abs(rms(h.saved[0]) - 12000 / Math.sqrt(2)) < 250);
    const args = h.children[0].args;
    assert.ok(!args.includes('false'), 'boolean CLI flags must not receive a false filename');
    h.children[0].child.emit('close', 0);
});

test('24-to-16 kHz conversion attenuates frequencies above the new Nyquist limit', async t => {
    const h = await sessionHarness(t);
    h.session.sendRealtimeInput(pcmTone(10000));
    await h.session.processAudioChunk();
    assert.ok(rms(h.saved[0]) < 600, 'downsampling must filter aliasing, not just relabel or drop samples');
    h.children[0].child.emit('close', 0);
});

test('24-to-16 kHz resampler preserves silence independently of the decode gate', () => {
    const output = require('../src/features/common/ai/providers/pcm24To16')(Buffer.alloc(48000));
    assert.equal(output.length, 32000);
    assert.equal(output.every(value => value === 0), true);
});
test('stdout-only nonzero exit reports code and both streams to logs and callbacks', async t => {
    const h = await sessionHarness(t);
    h.session.sendRealtimeInput(pcmTone(1000, 2400));
    await h.session.processAudioChunk();
    h.children[0].child.stdout.emit('data', 'WARNING: deprecated executable');
    h.children[0].child.emit('close', 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /1/);
    assert.match(h.errors[0].message, /deprecated executable/);
    assert.match(h.errors[0].message, /stdout/i);
    assert.match(h.errors[0].message, /stderr/i);
    assert.ok(h.messages.some(args => args.map(String).join(' ').includes('deprecated executable')));
    assert.deepEqual(h.cleaned, ['audio.wav']);
});

test('spawn errors surface once and cleanup still happens on close', async t => {
    const h = await sessionHarness(t);
    h.session.sendRealtimeInput(pcmTone(1000, 2400));
    await h.session.processAudioChunk();
    h.children[0].child.emit('error', new Error('spawn ENOENT'));
    h.children[0].child.emit('close', -2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0].message, /ENOENT/);
    assert.deepEqual(h.cleaned, ['audio.wav']);
});

test('successful CLI stdout becomes transcription', async t => {
    const h = await sessionHarness(t);
    const transcripts = [];
    h.session.on('transcription', event => transcripts.push(event.text));
    h.session.sendRealtimeInput(pcmTone(1000, 2400));
    await h.session.processAudioChunk();
    h.children[0].child.stdout.emit('data', 'A working local transcript.\n');
    h.children[0].child.emit('close', 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(transcripts, ['A working local transcript.']);
    assert.equal(h.errors.length, 0);
});

test('intentional shutdown does not emit an unhandled process failure', async t => {
    const h = await sessionHarness(t);
    h.session.sendRealtimeInput(pcmTone(1000, 2400));
    await h.session.processAudioChunk();
    await h.session.close();
    assert.doesNotThrow(() => h.children[0].child.emit('close', null, 'SIGTERM'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.cleaned, ['audio.wav']);
});

test('managed CLI installation status requires successful execution even without PATH', async () => {
    const h = serviceHarness();
    assert.equal(await h.service.isInstalled(), true);
    assert.ok(h.calls.length > 0);
});
test('broken managed CLI is not reported installed', async () => {
    const h = serviceHarness(async () => { throw new Error('missing DLL'); });
    assert.equal(await h.service.isInstalled(), false);
});
test('concurrent initialization shares one installation attempt', async () => {
    const h = serviceHarness();
    let attempts = 0;
    h.service.ensureDirectories = async () => {};
    h.service.ensureWhisperBinary = async () => { attempts++; await new Promise(resolve => setImmediate(resolve)); };
    await Promise.all([h.service.initialize(), h.service.initialize()]);
    assert.equal(attempts, 1);
});

function chunkMetrics(h) {
    return h.messages.filter(args => args[0] === 'DEBUG' && args[1] === '[WhisperSTT] chunk')
        .map(args => JSON.parse(args[2]));
}

for (const channel of ['my', 'their']) {
    test(channel + ' exact-zero chunk skips WAV creation and CLI spawn, then accepts nonzero audio', async t => {
        const h = await sessionHarness(t, undefined, channel + '_test');
        h.session.sendRealtimeInput(Buffer.alloc(72000));
        await h.session.processAudioChunk();
        assert.equal(h.children.length, 0);
        assert.equal(h.saved.length, 0);
        assert.equal(h.session.audioBuffer.length, 0);
        assert.equal(h.session.processing, false);
        assert.equal(chunkMetrics(h).length, 1);
        assert.equal(chunkMetrics(h)[0].channel, channel);
        assert.equal(chunkMetrics(h)[0].rms_dbfs, '-inf');
        assert.equal(chunkMetrics(h)[0].result, 'zero');
        assert.equal(chunkMetrics(h)[0].transcription, false);
        assert.equal(chunkMetrics(h)[0].audio_ms, 1500);
        const pcm = Buffer.alloc(72000);
        pcm.writeInt16LE(1, 40000); // One nonzero sample must decode even if resampling rounds it away.
        h.session.sendRealtimeInput(pcm);
        await h.session.processAudioChunk();
        assert.equal(h.children.length, 1);
        h.children[0].child.emit('close', 0);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(chunkMetrics(h).length, 2);
        assert.ok(Number.isFinite(chunkMetrics(h)[1].rms_dbfs));
        assert.equal(chunkMetrics(h)[1].result, 'empty');
        assert.equal(chunkMetrics(h)[1].seq, 2);
    });
}

test('PCM16 RMS uses signed samples and full-scale 32768 without gating near-zero values', () => {
    const stats = require('../src/features/common/ai/providers/pcm16Stats');
    assert.deepEqual(stats(Buffer.alloc(4)), { exactZero: true, rmsDbfs: -Infinity });
    const half = Buffer.alloc(8);
    [16384, -16384, 16384, -16384].forEach((v,i) => half.writeInt16LE(v, i*2));
    assert.ok(Math.abs(stats(half).rmsDbfs - (-6.020599913)) < 1e-8);
    const full = Buffer.alloc(2); full.writeInt16LE(-32768);
    assert.equal(stats(full).rmsDbfs, 0);
    const tiny = Buffer.alloc(2); tiny.writeInt16LE(-1);
    assert.equal(stats(tiny).exactZero, false);
    assert.ok(Math.abs(stats(tiny).rmsDbfs - (-90.308998699)) < 1e-8);
    const mixed = Buffer.alloc(4); mixed.writeInt16LE(-32768);
    assert.ok(Math.abs(stats(mixed).rmsDbfs - (-3.010299957)) < 1e-8);
    assert.throws(() => stats(Buffer.alloc(3)), /complete samples/);
});

test('chunk debug record distinguishes decoded text from duplicate suppression without logging text', async t => {
    const h = await sessionHarness(t);
    const transcripts = [];
    h.session.on('transcription', event => transcripts.push(event.text));
    for (let i=0; i<2; i++) {
        h.session.sendRealtimeInput(pcmTone(1000, 36000));
        await h.session.processAudioChunk();
        assert.equal(chunkMetrics(h).length, i, 'one result line only after completion');
        h.children[i].child.stdout.emit('data', 'fixture-private-transcript');
        h.children[i].child.emit('close', 0);
        await new Promise(resolve => setImmediate(resolve));
    }
    const metrics = chunkMetrics(h);
    assert.equal(metrics.length, 2);
    assert.equal(metrics[0].result, 'text');
    assert.equal(metrics[1].result, 'duplicate');
    assert.equal(metrics[0].transcription, true);
    assert.equal(metrics[1].transcription, true);
    assert.equal(metrics[0].emitted, true);
    assert.equal(metrics[1].emitted, false);
    assert.ok(Math.abs(metrics[0].rms_dbfs - (-11.74)) < 0.02);
    assert.ok(Date.parse(metrics[0].from) <= Date.parse(metrics[0].to));
    assert.ok(metrics[0].decode_ms >= 0);
    assert.deepEqual(transcripts, ['fixture-private-transcript']);
    for (const row of metrics) {
        assert.ok(JSON.stringify(row).length < 350);
        assert.ok(!JSON.stringify(row).includes('fixture-private-transcript'));
    }
});

test('one debug record for failed spawn plus close, with no successful transcription', async t => {
    const h = await sessionHarness(t);
    h.session.sendRealtimeInput(pcmTone(1000, 2400));
    await h.session.processAudioChunk();
    h.children[0].child.emit('error', new Error('spawn failed'));
    h.children[0].child.stdout.emit('data', 'not a successful transcript');
    h.children[0].child.emit('close', -2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(chunkMetrics(h).length, 1);
    assert.equal(chunkMetrics(h)[0].result, 'error');
    assert.equal(chunkMetrics(h)[0].transcription, false);
});

test('debug disabled still skips zero audio and decodes nonzero audio', async t => {
    const h = await sessionHarness(t, undefined, 'their_test', false);
    h.session.sendRealtimeInput(Buffer.alloc(72000));
    await h.session.processAudioChunk();
    assert.equal(h.children.length, 0);
    h.session.sendRealtimeInput(pcmTone(1000, 2400));
    await h.session.processAudioChunk();
    assert.equal(h.children.length, 1);
    h.children[0].child.emit('close', 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(chunkMetrics(h).length, 0);
});