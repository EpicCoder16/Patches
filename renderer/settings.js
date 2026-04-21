'use strict';

const keyForm = document.getElementById('key-form');
const keyInput = document.getElementById('api-key-input');
const keyLink = document.getElementById('key-link');
const toggleBtn = document.getElementById('toggle-visibility');
const saveBtn = document.getElementById('save-btn');
const errorText = document.getElementById('error-text');
const keyStatus = document.getElementById('key-status');

function showError(message) {
  errorText.textContent = message;
  errorText.classList.remove('hidden');
}

function clearError() {
  errorText.textContent = '';
  errorText.classList.add('hidden');
}

toggleBtn.addEventListener('click', () => {
  const show = keyInput.type === 'password';
  keyInput.type = show ? 'text' : 'password';
  toggleBtn.textContent = show ? 'Hide' : 'Show';
});

keyLink.addEventListener('click', () => {
  window.settingsAPI.openLink('https://aistudio.google.com/apikey');
});

keyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const value = keyInput.value.trim();
  if (!value) {
    showError('Please enter your Gemini API key.');
    return;
  }
  if (!value.startsWith('AIza')) {
    showError('Gemini API keys should start with AIza.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  const result = await window.settingsAPI.saveKey(value);
  if (!result || !result.success) {
    showError((result && result.error) || 'Unable to save key. Please try again.');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save & Launch';
  }
});

keyInput.addEventListener('input', () => {
  if (!errorText.classList.contains('hidden')) clearError();
});

async function initKeyStatus() {
  const state = await window.settingsAPI.getApiKeyStatus();
  if (state && state.hasKey) {
    keyStatus.textContent = `Current key detected: ${state.maskedKey}`;
    keyInput.value = state.key || '';
    saveBtn.textContent = 'Save & Relaunch';
    toggleBtn.textContent = 'Hide';
    keyInput.type = 'text';
  } else {
    keyStatus.textContent = 'No API key saved yet.';
    saveBtn.textContent = 'Save & Launch';
  }
  setTimeout(() => keyInput.focus(), 20);
}

initKeyStatus().catch(() => {
  keyStatus.textContent = 'Unable to read key status.';
  setTimeout(() => keyInput.focus(), 20);
});
