'use strict';

const keyForm = document.getElementById('key-form');
const keyInput = document.getElementById('api-key-input');
const keyLink = document.getElementById('key-link');
const toggleBtn = document.getElementById('toggle-visibility');
const saveBtn = document.getElementById('save-btn');
const errorText = document.getElementById('error-text');

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

setTimeout(() => keyInput.focus(), 20);
