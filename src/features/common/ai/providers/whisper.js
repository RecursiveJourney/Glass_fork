const pcm24To16 = require('./pcm24To16');
let spawn, path, EventEmitter;

if (typeof window === 'undefined') {
    spawn = require('child_process').spawn;
    path = require('path');
    EventEmitter = require('events').EventEmitter;
} else {
    class DummyEventEmitter {
        on() {}
        emit() {}
        removeAllListeners() {}
    }
    EventEmitter = DummyEventEmitter;
}

class WhisperSTTSession extends EventEmitter {
    constructor(model, whisperService, sessionId) {
        super();
        this.model = model;
        this.whisperService = whisperService;
        this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.process = null;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);
        this.processingInterval = null;
        this.lastTranscription = '';
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
        }
    }

    startProcessingLoop() {
        this.processingInterval = setInterval(async () => {
            const minBufferSize = 24000 * 2 * 0.15;
            if (this.audioBuffer.length >= minBufferSize && !this.process && !this.processing) {
                console.log(`[WhisperSTT-${this.sessionId}] Processing audio chunk, buffer size: ${this.audioBuffer.length}`);
                await this.processAudioChunk();
            }
        }, 1500);
    }

    async processAudioChunk() {
        if (!this.isRunning || this.audioBuffer.length === 0 || this.processing) return;
        this.processing = true;
        const audioData = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);
        let tempFile;
        let output = '';
        let errorOutput = '';
        let reported = false;
        const reportFailure = (code, reason = '') => {
            if (!this.isRunning) return; // Stop intentionally terminates the child.
            const error = new Error('Whisper exit code ' + code + (reason ? ': ' + reason : '') +
                '\nstdout:\n' + output + '\nstderr:\n' + errorOutput);
            console.error('[WhisperSTT-' + this.sessionId + '] Process error:', error.message);
            if (!reported && this.listenerCount('error') > 0) {
                reported = true;
                this.emit('error', error);
            }
        };
        try {
            tempFile = await this.whisperService.saveAudioToTemp(pcm24To16(audioData), this.sessionId);
            if (!tempFile || typeof tempFile !== 'string') throw new Error('Invalid temp file path');
            const whisperPath = await this.whisperService.getWhisperPath();
            const modelPath = await this.whisperService.getModelPath(this.model);
            if (!whisperPath || !modelPath) throw new Error('Invalid whisper or model path');
            if (!this.isRunning) {
                await this.whisperService.cleanupTempFile(tempFile);
                this.processing = false;
                return;
            }
            const child = spawn(whisperPath, [
                '-m', modelPath, '-f', tempFile, '--no-timestamps',
                '--language', 'auto', '--threads', '4'
            ], { windowsHide: true });
            this.process = child;
            child.stdout.on('data', data => { output += data.toString(); });
            child.stderr.on('data', data => { errorOutput += data.toString(); });
            child.on('error', error => reportFailure(error.code || 'spawn', error.message));
            child.on('close', async (code, signal) => {
                if (this.process === child) this.process = null;
                try {
                    if (code !== 0) reportFailure(code, signal || '');
                    else if (this.isRunning && output.trim() && !reported) {
                        const transcription = output.trim();
                        if (transcription !== this.lastTranscription) {
                            this.lastTranscription = transcription;
                            console.log('[WhisperSTT-' + this.sessionId + '] Transcription: "' + transcription + '"');
                            this.emit('transcription', {
                                text: transcription, timestamp: Date.now(),
                                confidence: 1.0, sessionId: this.sessionId
                            });
                        }
                    }
                } finally {
                    await this.whisperService.cleanupTempFile(tempFile);
                    this.processing = false;
                }
            });
        } catch (error) {
            reportFailure(error.code || 'setup', error.message);
            if (tempFile) await this.whisperService.cleanupTempFile(tempFile);
            this.processing = false;
        }
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning) {
            console.warn(`[WhisperSTT-${this.sessionId}] Session not running, cannot accept audio`);
            return;
        }

        if (typeof audioData === 'string') {
            try {
                audioData = Buffer.from(audioData, 'base64');
            } catch (error) {
                console.error('[WhisperSTT] Failed to decode base64 audio data:', error);
                return;
            }
        } else if (audioData instanceof ArrayBuffer) {
            audioData = Buffer.from(audioData);
        } else if (!Buffer.isBuffer(audioData) && !(audioData instanceof Uint8Array)) {
            console.error('[WhisperSTT] Invalid audio data type:', typeof audioData);
            return;
        }

        if (!Buffer.isBuffer(audioData)) {
            audioData = Buffer.from(audioData);
        }

        if (audioData.length > 0) {
            this.audioBuffer = Buffer.concat([this.audioBuffer, audioData]);
            // Log every 10th audio chunk to avoid spam
            if (Math.random() < 0.1) {
                console.log(`[WhisperSTT-${this.sessionId}] Received audio chunk: ${audioData.length} bytes, total buffer: ${this.audioBuffer.length} bytes`);
            }
        }
    }

    async close() {
        console.log(`[WhisperSTT-${this.sessionId}] Closing session`);
        this.isRunning = false;

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }

        this.removeAllListeners();
    }
}

class WhisperProvider {
    static async validateApiKey() {
        // Whisper is a local service, no API key validation needed.
        return { success: true };
    }

    constructor() {
        this.whisperService = null;
    }

    async initialize() {
        if (!this.whisperService) {
            this.whisperService = require('../../services/whisperService');
            if (!this.whisperService.isInitialized) {
                await this.whisperService.initialize();
            }
        }
    }

    async createSTT(config) {
        await this.initialize();
        
        const model = config.model || 'whisper-tiny';
        const sessionType = config.sessionType || 'unknown';
        console.log(`[WhisperProvider] Creating ${sessionType} STT session with model: ${model}`);
        
        // Create unique session ID based on type
        const sessionId = `${sessionType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const session = new WhisperSTTSession(model, this.whisperService, sessionId);
        
        // Log session creation
        console.log(`[WhisperProvider] Created session: ${sessionId}`);
        
        const initialized = await session.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize Whisper STT session');
        }

        if (config.callbacks) {
            if (config.callbacks.onmessage) {
                session.on('transcription', config.callbacks.onmessage);
            }
            if (config.callbacks.onerror) {
                session.on('error', config.callbacks.onerror);
            }
            if (config.callbacks.onclose) {
                session.on('close', config.callbacks.onclose);
            }
        }

        return session;
    }

    async createLLM() {
        throw new Error('Whisper provider does not support LLM functionality');
    }

    async createStreamingLLM() {
        console.warn('[WhisperProvider] Streaming LLM is not supported by Whisper.');
        throw new Error('Whisper does not support LLM.');
    }
}

module.exports = {
    WhisperProvider,
    WhisperSTTSession
};