const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = '../src/features/common/ai/parakeet/pcmStream';
const { PcmStream } = fs.existsSync(path.join(__dirname, modulePath + '.js')) ? require(modulePath) : {};
const convert = require('../src/features/common/ai/providers/pcm24To16');
function samples(count, fn = i => Math.round(24000 * Math.sin(i * 0.137) + 5000 * Math.cos(i * 0.319))) {
    const pcm = Buffer.alloc(count * 2);
    for (let i = 0; i < count; i++) pcm.writeInt16LE(fn(i), i * 2);
    return pcm;
}
function streamed(input, sizes) {
    const stream = new PcmStream({ channel: 'my' });
    const output = [], telemetry = [];
    let offset = 0, packet = 0;
    while (offset < input.length / 2) {
        const end = Math.min(input.length / 2, offset + sizes[packet++ % sizes.length]);
        const result = stream.push(input.subarray(offset * 2, end * 2), { firstSample: offset });
        output.push(result.pcm); telemetry.push(...result.telemetry); offset = end;
    }
    const tail = stream.flush(); output.push(tail.pcm); telemetry.push(...tail.telemetry);
    return { stream, pcm: Buffer.concat(output), telemetry };
}
test('exports a stateful resampler', () => assert.equal(typeof PcmStream, 'function'));
test('arbitrary packet boundaries retain exact converter phase and sample count', () => {
    const input = samples(72013), reference = convert(input);
    for (const sizes of [[1], [480], [512], [1, 2, 47, 481, 513, 7, 1024], [72013]]) assert.deepEqual(streamed(input, sizes).pcm, reference);
});
test('short residual tails and every phase match the one-shot helper', () => {
    for (let count = 0; count < 80; count++) assert.deepEqual(streamed(samples(count), [1, 2, 4]).pcm, convert(samples(count)));
});
test('odd-byte rejection and discontinuity do not mutate stream state', () => {
    const stream = new PcmStream({ channel: 'my' });
    assert.throws(() => stream.push(Buffer.alloc(3)), /complete samples/);
    assert.throws(() => stream.push(Buffer.alloc(2), { firstSample: 2 }), /contiguous/);
    const input = samples(100);
    const first = stream.push(input);
    assert.deepEqual(Buffer.concat([first.pcm, stream.flush().pcm]), convert(input));
});
test('near-zero input is processed and never rejected by an energy threshold', () => {
    const input = samples(36000, () => 1);
    const result = streamed(input, [480]);
    assert.deepEqual(result.pcm, convert(input));
    assert.equal(result.telemetry[0].exactZero, false);
    assert.equal(result.telemetry[0].zeroCount, 0);
    assert.ok(Math.abs(result.telemetry[0].rmsDbfs - 20 * Math.log10(1 / 32768)) < 1e-12);
});
test('silence metadata advances the sample clock and preserves filter boundary context', () => {
    const a = samples(97), b = samples(131);
    const stream = new PcmStream({ channel: 'their' });
    const parts = [stream.push(a).pcm, stream.pushSilence(36000, { firstSample: 97 }).pcm, stream.push(b, { firstSample: 36097 }).pcm, stream.flush().pcm];
    assert.deepEqual(Buffer.concat(parts), convert(Buffer.concat([a, Buffer.alloc(72000), b])));
    assert.equal(stream.inputSamples, 36228);
    assert.equal(stream.outputSamples, Math.floor(36228 * 2 / 3));
});
test('fixed 1.5-second original-input telemetry has exact RMS and zero counts', () => {
    const input = samples(72009, i => i < 18000 ? 0 : i < 36000 ? 16384 : i < 72000 ? 0 : -32768);
    const a = streamed(input, [47, 480, 512]), b = streamed(input, [72009]);
    assert.deepEqual(a.telemetry, b.telemetry);
    assert.equal(a.telemetry.length, 3);
    const [mixed, zero, tail] = a.telemetry;
    assert.equal(mixed.firstSample, 0); assert.equal(mixed.sampleCount, 36000); assert.equal(mixed.zeroCount, 18000);
    assert.ok(Math.abs(mixed.rmsDbfs - 10 * Math.log10(0.125)) < 1e-12);
    assert.equal(zero.rmsDbfs, -Infinity); assert.equal(zero.exactZero, true); assert.equal(zero.firstSample, 36000);
    assert.equal(tail.firstSample, 72000); assert.equal(tail.sampleCount, 9); assert.equal(tail.rmsDbfs, 0);
    for (const record of a.telemetry) assert.deepEqual(Object.keys(record).sort(), ['channel', 'exactZero', 'firstSample', 'rmsDbfs', 'sampleCount', 'zeroCount'].sort());
});
test('instances keep channel filter and telemetry state isolated', () => {
    const my = new PcmStream({ channel: 'my' }), their = new PcmStream({ channel: 'their' });
    const a = samples(36200), b = samples(36200, () => 0), outA = [], outB = [];
    for (let i = 0; i < a.length; i += 960) { outA.push(my.push(a.subarray(i, i + 960)).pcm); outB.push(their.push(b.subarray(i, i + 960)).pcm); }
    const tailA = my.flush(), tailB = their.flush(); outA.push(tailA.pcm); outB.push(tailB.pcm);
    assert.deepEqual(Buffer.concat(outA), convert(a)); assert.deepEqual(Buffer.concat(outB), convert(b));
    assert.equal(tailA.telemetry[0].channel, 'my'); assert.equal(tailB.telemetry[0].channel, 'their'); assert.equal(tailB.telemetry[0].exactZero, true);
});
test('flush emits residual once and disallows further capture', () => {
    const stream = new PcmStream({ channel: 'my' }); stream.push(samples(100));
    assert.ok(stream.flush().pcm.length > 0);
    assert.deepEqual(stream.flush(), { pcm: Buffer.alloc(0), telemetry: [] });
    assert.throws(() => stream.push(samples(1)), /flushed/);
    assert.throws(() => stream.pushSilence(1), /flushed/);
});
test('invalid channels and unbounded inputs are rejected', () => {
    assert.throws(() => new PcmStream({ channel: 'other' }));
    const stream = new PcmStream({ channel: 'my' });
    for (const count of [-1, 0.5, 600001, Infinity]) assert.throws(() => stream.pushSilence(count));
    assert.throws(() => stream.push(Buffer.alloc(1200002)));
});
