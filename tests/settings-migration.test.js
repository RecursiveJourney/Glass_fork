const test = require('node:test');
const assert = require('node:assert/strict');
const runFixture = require('./helpers/credential-harness.cjs');
for (const scenario of ['fresh', 'plaintext', 'owners', 'ambiguous', 'missing-provider', 'stale-old', 'locked', 'rollback', 'restart', 'selection', 'repository', 'vault-unavailable', 'legacy-store', 'legacy-cleanup-failure', 'twin', 'twin-http', 'mixed-local', 'legacy-aes', 'schema-failure', 'source-race']) {
    test(`real SQLite credential fixture: ${scenario}`, { timeout: 25000 }, async () => {
        const result = await runFixture(scenario);
        assert.deepEqual(result, { passed: true }, `${scenario}: ${result.failure || 'failed'}`);
    });
}
