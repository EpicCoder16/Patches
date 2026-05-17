'use strict';
const fs = require('fs');
const path = require('path');

let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  
  try {
    const configPath = path.join(__dirname, 'firebase-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed.apiKey && parsed.projectId) {
        cachedConfig = parsed;
        return cachedConfig;
      }
    }
  } catch (err) {
    // ignore
  }

  // Fallback to environment variables
  cachedConfig = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
  };
  
  return cachedConfig;
}

/** @returns {boolean} */
function isFirebaseConfigured() {
  const config = loadConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

function getFirebaseWebConfig() {
  return loadConfig();
}

module.exports = {
  isFirebaseConfigured,
  getFirebaseWebConfig,
};
