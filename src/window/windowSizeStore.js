const fs = require('node:fs');
const path = require('node:path');
const names = new Set(['listen', 'ask', 'settings']);
function valid(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.owner === 'automatic') return Object.keys(value).length === 1;
    return (
        value.owner === 'user' &&
        Object.keys(value).length === 3 &&
        [value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768)
    );
}
class WindowSizeStore {
    constructor(file, io = fs) {
        this.file = file;
        this.io = io;
        this.values = {};
        this.error = null;
        try {
            const data = JSON.parse(io.readFileSync(file, 'utf8'));
            if (
                data?.version !== 1 ||
                Object.keys(data).length !== 2 ||
                !data.windows ||
                Array.isArray(data.windows) ||
                typeof data.windows !== 'object' ||
                Object.entries(data.windows).some(([name, value]) => !names.has(name) || !valid(value))
            )
                throw Error('invalid');
            this.values = data.windows;
        } catch (error) {
            if (error.code !== 'ENOENT') this.error = 'size_read_failed';
        }
    }
    get(name) {
        return this.values[name] ? { ...this.values[name] } : null;
    }
    set(name, value) {
        if (!names.has(name) || !valid(value)) throw Error('invalid_size_preference');
        if (this.error) throw Error(this.error);
        const next = { ...this.values, [name]: { ...value } },
            temp = this.file + '.' + process.pid + '.tmp';
        try {
            this.io.mkdirSync(path.dirname(this.file), { recursive: true });
            const fd = this.io.openSync(temp, 'w', 0o600);
            try {
                this.io.writeFileSync(fd, JSON.stringify({ version: 1, windows: next }));
                this.io.fsyncSync(fd);
            } finally {
                this.io.closeSync(fd);
            }
            this.io.renameSync(temp, this.file);
            this.values = next;
        } catch {
            throw Error('size_write_failed');
        } finally {
            try {
                this.io.unlinkSync(temp);
            } catch {}
        }
    }
}
module.exports = { WindowSizeStore };
