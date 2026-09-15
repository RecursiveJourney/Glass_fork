const crypto = require('node:crypto');
const schema = require('../../src/features/common/config/schema');
function createTable(db, name, spec = schema[name]) {
    db.exec(`CREATE TABLE "${name}" (${spec.columns.map(c => `"${c.name}" ${c.type}`).join(',')}${spec.constraints?.length ? ',' + spec.constraints.join(',') : ''})`);
}
function syntheticCodec() {
    const key = Buffer.alloc(32, 7);
    return {
        isEncryptionAvailable: () => true,
        encryptString(value) {
            const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), data]);
        },
        decryptString(blob) {
            const cipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
            cipher.setAuthTag(blob.subarray(12, 28));
            return Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString('utf8');
        },
    };
}
module.exports = { createTable, syntheticCodec };
