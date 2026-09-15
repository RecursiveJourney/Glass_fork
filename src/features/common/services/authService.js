const { onAuthStateChanged, signInWithCustomToken, signOut } = require('firebase/auth');
const { BrowserWindow, shell } = require('electron');
const { getFirebaseAuth } = require('./firebaseClient');
const fetch = require('node-fetch');
const encryptionService = require('./encryptionService');
const migrationService = require('./migrationService');
const sessionRepository = require('../repositories/session');
const providerSettingsRepository = require('../repositories/providerSettings');
const permissionService = require('./permissionService');

async function getVirtualKeyByEmail(email, idToken) {
    if (!idToken) {
        throw new Error('Firebase ID token is required for virtual key request');
    }

    const resp = await fetch('https://serverless-api-sf3o.vercel.app/api/virtual_key', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
        redirect: 'follow',
        timeout: 10000,
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
        throw new Error('virtual_key_request_failed');
    }

    const vKey = json?.data?.virtualKey || json?.data?.virtual_key || json?.data?.newVKey?.slug;

    if (!vKey) throw new Error('virtual key missing in response');
    return vKey;
}

class AuthService {
    constructor() {
        this.currentUserId = 'default_user';
        this.currentUserMode = 'local'; // 'local' or 'firebase'
        this.currentUser = null;
        this.isInitialized = false;

        // This ensures the key is ready before any login/logout state change.
        this.initializationPromise = null;

        sessionRepository.setAuthService(this);
    }

    initialize() {
        if (this.initializationPromise) return this.initializationPromise;
        this.initializationPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Object.assign(new Error('identity_unavailable'), { code: 'identity_unavailable' })), 10000);
            onAuthStateChanged(getFirebaseAuth(), user => {
                this.currentUser = user || null;
                this.currentUserId = user?.uid || 'default_user';
                this.currentUserMode = user ? 'firebase' : 'local';
                this.broadcastUserState();
                if (!this.isInitialized) { this.isInitialized = true; clearTimeout(timer); resolve(); }
                if (this.credentialsReady) this.completeCredentialInitialization();
            }, () => { clearTimeout(timer); reject(Object.assign(new Error('identity_unavailable'), { code: 'identity_unavailable' })); });
        });
        return this.initializationPromise;
    }

    completeCredentialInitialization() {
        this.credentialsReady = true;
        const user = this.currentUser;
        const run = async () => {
            if (this.currentUser !== user) return;
            await sessionRepository.endAllActiveSessions();
            if (!user) {
                encryptionService.resetSessionKey();
                if (global.modelStateService) await global.modelStateService.setFirebaseVirtualKey(null);
                return;
            }
            // Provider legacy reads have completed before this may create a Personalize key.
            if (process.platform !== 'darwin' || await permissionService.checkKeychainCompleted(user.uid)) await encryptionService.initializeKey(user.uid);
            Promise.resolve(migrationService.checkAndRunMigration(user)).catch(() => console.warn('[Auth] account_migration_failed'));
            const idToken = await user.getIdToken(true);
            require('./secretRedactor').registerSecrets([idToken]);
            const virtualKey = await getVirtualKeyByEmail(user.email, idToken);
            require('./secretRedactor').registerSecrets([virtualKey]);
            if (this.currentUser === user && global.modelStateService) await global.modelStateService.setFirebaseVirtualKey(virtualKey);
        };
        this.credentialWork = (this.credentialWork || Promise.resolve()).then(run).catch(() => console.warn('[Auth] credential_refresh_failed'));
        return this.credentialWork;
    }
    async startFirebaseAuthFlow() {
        try {
            const webUrl = process.env.pickleglass_WEB_URL || 'http://localhost:3000';
            const authUrl = `${webUrl}/login?mode=electron`;
            console.log(`[AuthService] Opening Firebase auth URL in browser: ${authUrl}`);
            await shell.openExternal(authUrl);
            return { success: true };
        } catch (error) {
            console.error('[AuthService] Failed to open Firebase auth URL:', error);
            return { success: false, error: error.message };
        }
    }

    async signInWithCustomToken(token) {
        require('./secretRedactor').registerSecrets([token]);
        const auth = getFirebaseAuth();
        try {
            const userCredential = await signInWithCustomToken(auth, token);
            console.log(`[AuthService] Successfully signed in with custom token for user:`, userCredential.user.uid);
            // onAuthStateChanged will handle the state update and broadcast
        } catch (error) {
            console.error('[AuthService] Error signing in with custom token:', error);
            throw error; // Re-throw to be handled by the caller
        }
    }

    async signOut() {
        const auth = getFirebaseAuth();
        try {
            // End all active sessions for the current user BEFORE signing out.
            await sessionRepository.endAllActiveSessions();

            await signOut(auth);
            console.log('[AuthService] User sign-out initiated successfully.');
            // onAuthStateChanged will handle the state update and broadcast,
            // which will also re-evaluate the API key status.
        } catch (error) {
            console.error('[AuthService] Error signing out:', error);
        }
    }
    
    broadcastUserState() {
        const userState = this.getCurrentUser();
        console.log('[AuthService] Broadcasting user state change:', userState);
        BrowserWindow.getAllWindows().forEach(win => {
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send('user-state-changed', userState);
            }
        });
    }

    getCurrentUserId() {
        return this.currentUserId;
    }

    getCurrentUser() {
        const isLoggedIn = !!(this.currentUserMode === 'firebase' && this.currentUser);

        if (isLoggedIn) {
            return {
                uid: this.currentUser.uid,
                email: this.currentUser.email,
                displayName: this.currentUser.displayName,
                mode: 'firebase',
                isLoggedIn: true,
                //////// before_modelStateService ////////
                // hasApiKey: this.hasApiKey // Always true for firebase users, but good practice
                //////// before_modelStateService ////////
            };
        }
        return {
            uid: this.currentUserId, // returns 'default_user'
            email: 'contact@pickle.com',
            displayName: 'Default User',
            mode: 'local',
            isLoggedIn: false,
            //////// before_modelStateService ////////
            // hasApiKey: this.hasApiKey
            //////// before_modelStateService ////////
        };
    }
}

const authService = new AuthService();
module.exports = authService;
