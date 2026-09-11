// Measure the incoming signed PCM16 without applying any energy threshold.
module.exports = function pcm16Stats(pcm) {
    if (pcm.length % 2) throw new Error('PCM16 input must contain complete samples');
    let sumSquares = 0;
    for (let i = 0; i < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        sumSquares += sample * sample;
    }
    return {
        exactZero: sumSquares === 0,
        rmsDbfs: sumSquares === 0 ? -Infinity :
            10 * Math.log10(sumSquares / (pcm.length / 2) / (32768 * 32768))
    };
};
