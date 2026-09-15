const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const directory = process.argv[2], mode = process.argv[3];
app.setPath('userData', path.join(directory, 'profile'));
app.whenReady().then(() => {
    const { SecretStore } = require('../../src/features/common/services/secretStore');
    const store = new SecretStore(), binding = { ref: 'synthetic-reference', scope: 'synthetic-installation/provider/fireflies' };
    const file = path.join(directory, 'encrypted-fixture.bin');
    if (mode === 'write') fs.writeFileSync(file, store.seal('synthetic-os-restart-marker', binding));
    else if (store.open(fs.readFileSync(file), binding) !== 'synthetic-os-restart-marker') throw Error('restart_read_failed');
    process.stdout.write('SAFE_STORAGE_RESULT:ok\n'); app.quit();
}).catch(() => { process.stdout.write('SAFE_STORAGE_RESULT:failed\n'); app.exit(1); });
