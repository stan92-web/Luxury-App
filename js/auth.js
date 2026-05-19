/* ══════════════════════════════════════════════
   auth.js — Simple access code protection
   Change the CODE value below to update password
══════════════════════════════════════════════ */

const Auth = (() => {
  const CODE       = '305581';
  const STORAGE_KEY = 'lh_auth_v1';

  function init() {
    if (localStorage.getItem(STORAGE_KEY) === 'granted') {
      showApp();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app-wrap').style.display    = 'none';
    setTimeout(() => document.getElementById('auth-input').focus(), 100);
  }

  function showApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-wrap').style.display    = 'block';
  }

  function attempt() {
    const val = document.getElementById('auth-input').value.trim();
    if (val === CODE) {
      localStorage.setItem(STORAGE_KEY, 'granted');
      showApp();
    } else {
      const box = document.getElementById('auth-box');
      box.classList.remove('shake');
      void box.offsetWidth; // restart animation
      box.classList.add('shake');
      document.getElementById('auth-error').style.opacity = '1';
      document.getElementById('auth-input').value = '';
      document.getElementById('auth-input').focus();
    }
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    document.getElementById('auth-input').value = '';
    document.getElementById('auth-error').style.opacity = '0';
    showLogin();
  }

  // Allow pressing Enter to submit
  document.addEventListener('DOMContentLoaded', () => {
    init();
    document.getElementById('auth-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') attempt();
    });
  });

  return { attempt, logout };
})();
