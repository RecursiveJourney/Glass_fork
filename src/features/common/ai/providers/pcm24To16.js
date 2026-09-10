// Glass capture stays at 24 kHz for the other STT providers. Convert only Whisper's
// PCM16 boundary to 16 kHz, matching its WAV header. A windowed-sinc low-pass filter
// removes frequencies above the new Nyquist limit before the 3:2 downsampling.
const RADIUS = 24;
const CUTOFF = 0.30; // cycles per 24 kHz input sample; transition below 8 kHz.
const phases = [0, 0.5].map(phase => {
    const taps = [];
    for (let offset = -RADIUS; offset <= RADIUS; offset++) {
        const distance = offset - phase;
        const sinc = distance === 0 ? 2 * CUTOFF :
            Math.sin(2 * Math.PI * CUTOFF * distance) / (Math.PI * distance);
        const window = 0.5 * (1 + Math.cos(Math.PI * distance / (RADIUS + 1)));
        taps.push({ offset, weight: sinc * window });
    }
    const sum = taps.reduce((total, tap) => total + tap.weight, 0);
    return taps.map(tap => ({ offset: tap.offset, weight: tap.weight / sum }));
});

module.exports = function pcm24To16(input) {
    if (input.length % 2) throw new Error('PCM16 input must contain complete samples');
    const samples = input.length / 2;
    const output = Buffer.alloc(Math.floor(samples * 2 / 3) * 2);
    for (let i = 0; i < output.length / 2; i++) {
        const center = Math.floor(i * 1.5);
        let value = 0;
        for (const tap of phases[i % 2]) {
            const index = Math.max(0, Math.min(samples - 1, center + tap.offset));
            value += input.readInt16LE(index * 2) * tap.weight;
        }
        output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
    }
    return output;
};
