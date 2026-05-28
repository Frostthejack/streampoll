// auth.js — OAuth UI
import { invoke } from '@tauri-apps/api/core';

export function initAuth() {
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');

  if (btnLogin) {
    btnLogin.addEventListener('click', async () => {
      // First save credentials
      const clientId = document.getElementById('input-client-id')?.value?.trim();
      const clientSecret = document.getElementById('input-client-secret')?.value?.trim();

      if (!clientId || !clientSecret) {
        window.showToast('Enter Client ID and Client Secret first', 'error');
        return;
      }

      // Save settings with credentials
      try {
        const settings = await invoke('get_settings');
        settings.client_id = clientId;
        settings.client_secret = clientSecret;
        await invoke('save_settings', { newSettings: settings });
      } catch (e) {
        console.error('Failed to save credentials:', e);
      }

      btnLogin.textContent = '⏳ Opening browser...';
      btnLogin.disabled = true;

      try {
        await invoke('login');
        window.showToast('Connected to Restream!');
      } catch (e) {
        window.showToast('Login failed: ' + e, 'error');
        btnLogin.textContent = '🔐 Connect to Restream';
        btnLogin.disabled = false;
      }
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await invoke('logout');
        window.showToast('Disconnected');
      } catch (e) {
        window.showToast('Error: ' + e, 'error');
      }
    });
  }
}
