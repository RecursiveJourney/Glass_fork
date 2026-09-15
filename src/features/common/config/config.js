// Configuration management for environment-based settings
const os = require('os');
const path = require('path');
const fs = require('fs');

class Config {
    constructor() {
        this.env = process.env.NODE_ENV || 'development';
        this.defaults = {
            apiUrl: process.env.pickleglass_API_URL || 'http://localhost:9001',
            apiTimeout: 10000,
            
            webUrl: process.env.pickleglass_WEB_URL || 'http://localhost:3000',
            
            enableJWT: false,
            fallbackToHeaderAuth: false,
            
            cacheTimeout: 5 * 60 * 1000,
            enableCaching: true,
            
            syncInterval: 0,
            healthCheckInterval: 30 * 1000,
            
            defaultWindowWidth: 400,
            defaultWindowHeight: 60,
            
            enableOfflineMode: true,
            enableFileBasedCommunication: false,
            enableSQLiteStorage: true,
            
            logLevel: 'info',
            enableDebugLogging: false
        };
        
        this.config = { ...this.defaults };
        this.loadEnvironmentConfig();
        this.loadUserConfig();
    }
    
    loadEnvironmentConfig() {
        if (process.env.pickleglass_API_URL) {
            this.config.apiUrl = process.env.pickleglass_API_URL;
            console.log(`[Config] API URL from env: ${this.config.apiUrl}`);
        }
        
        if (process.env.pickleglass_WEB_URL) {
            this.config.webUrl = process.env.pickleglass_WEB_URL;
            console.log(`[Config] Web URL from env: ${this.config.webUrl}`);
        }
        
        if (process.env.pickleglass_API_TIMEOUT) {
            this.config.apiTimeout = parseInt(process.env.pickleglass_API_TIMEOUT);
        }
        
        if (process.env.pickleglass_ENABLE_JWT) {
            this.config.enableJWT = process.env.pickleglass_ENABLE_JWT === 'true';
        }
        
        if (process.env.pickleglass_CACHE_TIMEOUT) {
            this.config.cacheTimeout = parseInt(process.env.pickleglass_CACHE_TIMEOUT);
        }
        
        if (process.env.pickleglass_LOG_LEVEL) {
            this.config.logLevel = process.env.pickleglass_LOG_LEVEL;
        }
        
        if (process.env.pickleglass_DEBUG) {
            this.config.enableDebugLogging = process.env.pickleglass_DEBUG === 'true';
        }
        
        if (this.env === 'production') {
            this.config.enableDebugLogging = false;
            this.config.logLevel = 'warn';
        } else if (this.env === 'development') {
            this.config.enableDebugLogging = true;
            this.config.logLevel = 'debug';
        }
    }
    
    loadUserConfig() {
        try {
            const userConfigPath = this.getUserConfigPath();
            const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
            if (!userConfig || typeof userConfig !== 'object' || Array.isArray(userConfig)) throw new Error('invalid_config');
            this.config = { ...this.config, ...userConfig };
            this.loadError = null;
        } catch (error) {
            this.loadError = error.code === 'ENOENT' ? null : 'config_read_failed';
        }
    }
    
    getUserConfigPath() {
        const configDir = path.join(os.homedir(), '.pickleglass');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        return path.join(configDir, 'config.json');
    }
    
    get(key) {
        return this.config[key];
    }
    
    set(key, value) {
        this.config[key] = value;
    }
    
    getAll() {
        return { ...this.config };
    }
    
    saveUserConfig() {
        if (this.loadError) throw Object.assign(new Error(this.loadError), { code: this.loadError });
        let temporary;
        try {
            const userConfigPath = this.getUserConfigPath();
            const userConfig = { ...this.config };
            
            Object.keys(this.defaults).forEach(key => {
                if (userConfig[key] === this.defaults[key]) {
                    delete userConfig[key];
                }
            });
            
            temporary = userConfigPath + '.' + process.pid + '.tmp';
            const fd = fs.openSync(temporary, 'w', 0o600);
            try { fs.writeFileSync(fd, JSON.stringify(userConfig, null, 2)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(temporary, userConfigPath);
            console.log('[Config] User config saved to:', userConfigPath);
        } catch (error) {
            throw Object.assign(new Error('config_write_failed'), { code: 'config_write_failed' });
        } finally {
            if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
        }
    }
    
    reset() {
        this.config = { ...this.defaults };
        this.loadEnvironmentConfig();
    }
    
    isDevelopment() {
        return this.env === 'development';
    }
    
    isProduction() {
        return this.env === 'production';
    }
    
    shouldLog(level) {
        const levels = ['debug', 'info', 'warn', 'error'];
        const currentLevelIndex = levels.indexOf(this.config.logLevel);
        const requestedLevelIndex = levels.indexOf(level);
        return requestedLevelIndex >= currentLevelIndex;
    }
}

const config = new Config();

module.exports = config;
