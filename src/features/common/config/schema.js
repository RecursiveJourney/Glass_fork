const LATEST_SCHEMA = {
    users: {
        columns: [
            { name: 'uid', type: 'TEXT PRIMARY KEY' },
            { name: 'display_name', type: 'TEXT NOT NULL' },
            { name: 'email', type: 'TEXT NOT NULL' },
            { name: 'created_at', type: 'INTEGER' },
            { name: 'auto_update_enabled', type: 'INTEGER DEFAULT 1' },
            { name: 'has_migrated_to_firebase', type: 'INTEGER DEFAULT 0' }
        ]
    },
    sessions: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' },
            { name: 'uid', type: 'TEXT NOT NULL' },
            { name: 'title', type: 'TEXT' },
            { name: 'session_type', type: 'TEXT DEFAULT \'ask\'' },
            { name: 'started_at', type: 'INTEGER' },
            { name: 'ended_at', type: 'INTEGER' },
            { name: 'sync_state', type: 'TEXT DEFAULT \'clean\'' },
            { name: 'updated_at', type: 'INTEGER' }
        ]
    },
    transcripts: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' },
            { name: 'session_id', type: 'TEXT NOT NULL' },
            { name: 'start_at', type: 'INTEGER' },
            { name: 'end_at', type: 'INTEGER' },
            { name: 'speaker', type: 'TEXT' },
            { name: 'text', type: 'TEXT' },
            { name: 'lang', type: 'TEXT' },
            { name: 'created_at', type: 'INTEGER' },
            { name: 'sync_state', type: 'TEXT DEFAULT \'clean\'' }
        ]
    },
    ai_messages: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' },
            { name: 'session_id', type: 'TEXT NOT NULL' },
            { name: 'sent_at', type: 'INTEGER' },
            { name: 'role', type: 'TEXT' },
            { name: 'content', type: 'TEXT' },
            { name: 'tokens', type: 'INTEGER' },
            { name: 'model', type: 'TEXT' },
            { name: 'created_at', type: 'INTEGER' },
            { name: 'sync_state', type: 'TEXT DEFAULT \'clean\'' }
        ]
    },
    summaries: {
        columns: [
            { name: 'session_id', type: 'TEXT PRIMARY KEY' },
            { name: 'generated_at', type: 'INTEGER' },
            { name: 'model', type: 'TEXT' },
            { name: 'text', type: 'TEXT' },
            { name: 'tldr', type: 'TEXT' },
            { name: 'bullet_json', type: 'TEXT' },
            { name: 'action_json', type: 'TEXT' },
            { name: 'tokens_used', type: 'INTEGER' },
            { name: 'updated_at', type: 'INTEGER' },
            { name: 'sync_state', type: 'TEXT DEFAULT \'clean\'' }
        ]
    },
    prompt_presets: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' },
            { name: 'uid', type: 'TEXT NOT NULL' },
            { name: 'title', type: 'TEXT NOT NULL' },
            { name: 'prompt', type: 'TEXT NOT NULL' },
            { name: 'is_default', type: 'INTEGER NOT NULL' },
            { name: 'created_at', type: 'INTEGER' },
            { name: 'sync_state', type: 'TEXT DEFAULT \'clean\'' }
        ]
    },
    ollama_models: {
        columns: [
            { name: 'name', type: 'TEXT PRIMARY KEY' },
            { name: 'size', type: 'TEXT NOT NULL' },
            { name: 'installed', type: 'INTEGER DEFAULT 0' },
            { name: 'installing', type: 'INTEGER DEFAULT 0' }
        ]
    },
    whisper_models: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' },
            { name: 'name', type: 'TEXT NOT NULL' },
            { name: 'size', type: 'TEXT NOT NULL' },
            { name: 'installed', type: 'INTEGER DEFAULT 0' },
            { name: 'installing', type: 'INTEGER DEFAULT 0' }
        ]
    },
    provider_settings: {
        columns: [
            { name: 'provider', type: 'TEXT NOT NULL' },
            { name: 'api_key', type: 'TEXT' },
            { name: 'credential_ref', type: 'TEXT' },
            { name: 'enabled', type: 'INTEGER DEFAULT 0' },
            { name: 'credential_status', type: "TEXT DEFAULT 'missing'" },
            { name: 'owner_scope', type: 'TEXT' },
            { name: 'selected_llm_model', type: 'TEXT' },
            { name: 'selected_stt_model', type: 'TEXT' },
            { name: 'is_active_llm', type: 'INTEGER DEFAULT 0' },
            { name: 'is_active_stt', type: 'INTEGER DEFAULT 0' },
            { name: 'created_at', type: 'INTEGER' },
            { name: 'updated_at', type: 'INTEGER' }
        ],
        constraints: ['PRIMARY KEY (provider)']
    },
    secret_records: {
        columns: [
            { name: 'ref', type: 'TEXT PRIMARY KEY' }, { name: 'scope', type: 'TEXT NOT NULL' },
            { name: 'format_version', type: 'INTEGER NOT NULL' }, { name: 'ciphertext', type: 'BLOB NOT NULL' },
            { name: 'created_at', type: 'INTEGER' }, { name: 'updated_at', type: 'INTEGER' }
        ]
    },
    settings_migrations: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' }, { name: 'version', type: 'INTEGER' },
            { name: 'stage', type: 'TEXT' }, { name: 'result_code', type: 'TEXT' }, { name: 'updated_at', type: 'INTEGER' }
        ]
    },
    settings_recovery_records: {
        columns: [
            { name: 'id', type: 'TEXT PRIMARY KEY' }, { name: 'source_kind', type: 'TEXT' },
            { name: 'owner_alias', type: 'TEXT' }, { name: 'provider', type: 'TEXT' },
            { name: 'ciphertext', type: 'BLOB NOT NULL' }, { name: 'format_version', type: 'INTEGER' },
            { name: 'resolved', type: 'INTEGER DEFAULT 0' }
        ]
    },
    twin_settings: {
        columns: [
            { name: 'id', type: 'INTEGER PRIMARY KEY CHECK(id=1)' }, { name: 'installation_id', type: 'TEXT NOT NULL' },
            { name: 'desired_revision', type: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'fireflies_enabled', type: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'fireflies_credential_ref', type: 'TEXT' }, { name: 'normalized_meeting_link', type: 'TEXT' },
            { name: 'meeting_intent_id', type: 'TEXT' }, { name: 'updated_at', type: 'INTEGER' }
        ]
    },
    twin_apply_outbox: {
        columns: [
            { name: 'id', type: 'INTEGER PRIMARY KEY CHECK(id=1)' }, { name: 'desired_revision', type: 'INTEGER' },
            { name: 'operation_id', type: 'TEXT' }, { name: 'action', type: 'TEXT' }, { name: 'state', type: 'TEXT' },
            { name: 'last_error_code', type: 'TEXT' }, { name: 'applied_revision', type: 'INTEGER DEFAULT 0' },
            { name: 'server_instance', type: 'TEXT' }
        ]
    },
    shortcuts: {
        columns: [
            { name: 'action', type: 'TEXT PRIMARY KEY' },
            { name: 'accelerator', type: 'TEXT NOT NULL' },
            { name: 'created_at', type: 'INTEGER' }
        ]
    },
    permissions: {
        columns: [
            { name: 'uid', type: 'TEXT PRIMARY KEY' },
            { name: 'keychain_completed', type: 'INTEGER DEFAULT 0' }
        ]
    }
};

module.exports = LATEST_SCHEMA;
