// One main-process origin for control, models, inference and meeting events.
function twinBaseUrl() {
    const value = process.env.TWIN_CONTROL_URL ?? 'http://localhost:11434';
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
            url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
        return url.origin;
    } catch {
        // Never expose a malformed URL (which may contain credentials), or fall back to the demo.
        throw Object.assign(new Error('invalid_runtime_url'), { code: 'invalid_runtime_url' });
    }
}
module.exports = { twinBaseUrl };
