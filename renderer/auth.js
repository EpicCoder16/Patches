'use strict';

(function initAuthGate() {
  const overlay = document.getElementById('auth-overlay');
  const checking = document.getElementById('auth-checking');
  const formWrap = document.getElementById('auth-form-wrap');
  const tabs = document.getElementById('auth-tabs');
  const form = document.getElementById('auth-form');
  const emailInput = document.getElementById('auth-email');
  const passwordInput = document.getElementById('auth-password');
  const submitBtn = document.getElementById('auth-submit');
  const errorEl = document.getElementById('auth-error');
  const subtitle = document.getElementById('auth-subtitle');

  let mode = 'signin';
  let firebaseReady = false;
  let authUnsubscribe = null;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }
  function clearError() {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    emailInput.disabled = loading;
    passwordInput.disabled = loading;
    submitBtn.textContent = loading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account';
  }

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.auth-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.mode === mode);
    });
    submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    subtitle.textContent =
      mode === 'signin'
        ? 'Sign in to sync your patches across devices.'
        : 'Create an account to save patches in the cloud.';
    clearError();
  }

  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  async function loadCloudPatches(uid) {
    const snap = await firebase
      .firestore()
      .collection('users')
      .doc(uid)
      .collection('data')
      .doc('patches')
      .get();
    if (!snap.exists) return {};
    const raw = snap.data().json;
    if (!raw) return {};
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return {};
    }
  }

  async function saveCloudPatches(uid, patches) {
    await firebase
      .firestore()
      .collection('users')
      .doc(uid)
      .collection('data')
      .doc('patches')
      .set({ json: JSON.stringify(patches), updatedAt: Date.now() }, { merge: true });
  }

  async function completeSession(user) {
    const idToken = await user.getIdToken();
    const patches = await loadCloudPatches(user.uid);
    await window.authAPI.notifyAuthSuccess({
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      idToken,
      patches,
    });
    overlay.classList.add('hidden');
    document.body.classList.remove('auth-locked');
  }

  function showLoginForm() {
    checking.classList.add('hidden');
    formWrap.classList.remove('hidden');
    tabs.classList.remove('hidden');
    setTimeout(() => emailInput.focus(), 50);
  }

  async function initFirebase() {
    const cfg = await window.authAPI.getFirebaseConfig();
    if (!cfg.configured) {
      showLoginForm();
      showError('Firebase keys missing from .env. Add them and restart the app.');
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(cfg.webConfig);
    }
    firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    firebaseReady = true;

    window.authAPI.onPatchesSyncRequest(async (patches) => {
      const user = firebase.auth().currentUser;
      if (!user) return;
      try {
        await saveCloudPatches(user.uid, patches);
      } catch (err) {
        console.error('[auth] cloud sync failed:', err);
      }
    });

    authUnsubscribe = firebase.auth().onAuthStateChanged(async (user) => {
      if (user) {
        try {
          await completeSession(user);
        } catch (err) {
          showLoginForm();
          showError(err.message || 'Could not restore your session.');
        }
      } else {
        showLoginForm();
      }
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!firebaseReady) return;
    clearError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showError('Enter your email and password.');
      return;
    }
    if (password.length < 6) {
      showError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signin') {
        await firebase.auth().signInWithEmailAndPassword(email, password);
      } else {
        await firebase.auth().createUserWithEmailAndPassword(email, password);
      }
    } catch (err) {
      const code = err.code || '';
      const messages = {
        'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
        'auth/invalid-email': 'Enter a valid email address.',
        'auth/user-not-found': 'No account found for this email.',
        'auth/wrong-password': 'Incorrect password.',
        'auth/invalid-credential': 'Invalid email or password.',
        'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
        'auth/weak-password': 'Password must be at least 6 characters.',
      };
      showError(messages[code] || err.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  });

  emailInput.addEventListener('input', clearError);
  passwordInput.addEventListener('input', clearError);

  window.authAPI.onAuthRequired(async () => {
    overlay.classList.remove('hidden');
    document.body.classList.add('auth-locked');
    clearError();
    if (firebaseReady) {
      try {
        await firebase.auth().signOut();
      } catch {
        /* session may already be cleared */
      }
    }
    showLoginForm();
  });

  initFirebase().catch((err) => {
    showLoginForm();
    showError(err.message || 'Could not start authentication.');
  });
})();
