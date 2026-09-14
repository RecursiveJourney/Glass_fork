const pcm24To16 = require('../providers/pcm24To16');
const pcm16Stats = require('../providers/pcm16Stats');
const { LIMITS } = require('./protocol');
const FILTER_RADIUS = 24; // Must match pcm24To16's existing finite filter support.
const TELEMETRY_SAMPLES = 36000;

/** Independent 24 kHz PCM16LE -> 16 kHz PCM16LE stream, beginning at source sample 0.
 * push(bytes, { firstSample? }) and pushSilence(count, { firstSample? }) return
 * { pcm: Buffer, telemetry: [...] }. Silence still reaches the converter as zeros.
 * flush() finalizes clamped filter edges and a partial telemetry interval exactly once.
 * inputSamples/outputSamples are cumulative source/output counts; do not mutate them.
 * Telemetry contains original-input measurements only, with -Infinity for exact zero.
 */
class PcmStream {
    constructor({ channel } = {}) {
        if (!['my', 'their'].includes(channel)) throw new TypeError('Invalid channel');
        this.channel = channel;
        this.inputSamples = 0;
        this.outputSamples = 0;
        this._start = 0;
        this._pending = Buffer.alloc(0);
        this._stats = Buffer.alloc(TELEMETRY_SAMPLES * 2);
        this._statsSamples = 0;
        this._statsStart = 0;
        this._flushed = false;
    }
    _validate(count, firstSample) {
        if (this._flushed) throw new Error('Stream already flushed');
        if (!Number.isSafeInteger(count) || count < 0 || count > LIMITS.maxAudioSamples || !Number.isSafeInteger(this.inputSamples + count)) throw new TypeError('Invalid sampleCount');
        if (firstSample !== undefined && firstSample !== this.inputSamples) throw new Error('Capture must be contiguous');
    }
    push(bytes, { firstSample } = {}) {
        if (!(bytes instanceof Uint8Array)) throw new TypeError('PCM must be bytes');
        if (bytes.byteLength % 2) throw new TypeError('PCM16 input must contain complete samples');
        this._validate(bytes.byteLength / 2, firstSample);
        // Taking an owned copy also normalizes Uint8Array views to the helper's Buffer API.
        return this._append(Buffer.from(bytes));
    }
    pushSilence(sampleCount, { firstSample } = {}) {
        this._validate(sampleCount, firstSample);
        const output = [], telemetry = [];
        // Materialize zeros in fixed blocks even for long metadata-only capture gaps.
        while (sampleCount > 0) {
            const count = Math.min(sampleCount, TELEMETRY_SAMPLES);
            const part = this._append(Buffer.alloc(count * 2));
            output.push(part.pcm); telemetry.push(...part.telemetry); sampleCount -= count;
        }
        return { pcm: Buffer.concat(output), telemetry };
    }
    _append(bytes) {
        const telemetry = [];
        let offset = 0;
        while (offset < bytes.length) {
            const count = Math.min(bytes.length / 2 - offset / 2, TELEMETRY_SAMPLES - this._statsSamples);
            bytes.copy(this._stats, this._statsSamples * 2, offset, offset + count * 2);
            this._statsSamples += count; offset += count * 2;
            if (this._statsSamples === TELEMETRY_SAMPLES) telemetry.push(this._record());
        }
        this._pending = Buffer.concat([this._pending, bytes]);
        this.inputSamples += bytes.length / 2;
        return { pcm: this._convert(false), telemetry };
    }
    _record() {
        const original = this._stats.subarray(0, this._statsSamples * 2);
        let zeroCount = 0;
        for (let i = 0; i < original.length; i += 2) if (original.readInt16LE(i) === 0) zeroCount++;
        const record = { channel: this.channel, firstSample: this._statsStart, sampleCount: this._statsSamples, ...pcm16Stats(original), zeroCount };
        this._statsStart += this._statsSamples; this._statsSamples = 0;
        return record;
    }
    _convert(final) {
        // A sample can be emitted only after all +24 filter taps are known. Starting
        // each overlap on a multiple of 3 keeps helper output phases aligned globally.
        const end = final ? Math.floor(this.inputSamples * 2 / 3) : Math.max(0, Math.ceil((this.inputSamples - FILTER_RADIUS) * 2 / 3));
        if (end <= this.outputSamples) return Buffer.alloc(0);
        const localOutputStart = this._start * 2 / 3;
        const converted = pcm24To16(this._pending);
        const pcm = Buffer.from(converted.subarray((this.outputSamples - localOutputStart) * 2, (end - localOutputStart) * 2));
        this.outputSamples = end;
        const keepFrom = Math.floor(Math.max(0, Math.floor(end * 1.5) - FILTER_RADIUS) / 3) * 3;
        this._pending = Buffer.from(this._pending.subarray((keepFrom - this._start) * 2));
        this._start = keepFrom;
        return pcm;
    }
    flush() {
        if (this._flushed) return { pcm: Buffer.alloc(0), telemetry: [] };
        const pcm = this._convert(true);
        const telemetry = this._statsSamples ? [this._record()] : [];
        this._flushed = true;
        this._pending = Buffer.alloc(0);
        this._stats = Buffer.alloc(0);
        return { pcm, telemetry };
    }
}
module.exports = { PcmStream, TELEMETRY_SAMPLES };
