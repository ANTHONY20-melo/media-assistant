/* Storage — wrapper localStorage com prefixo (padrão do projeto finanças).
 * Guarda: configurações (assinatura, chave de API), histórico de análises. */
'use strict';

const Storage = (() => {
  const PREFIX = 'jarvis_media_';

  function get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_e) {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (_e) { /* quota/privacidade: falha silenciosa */ }
  }

  const DEFAULT_SETTINGS = {
    signature: {
      enabled: true,
      mode: 'text',           // 'text' | 'image'
      text: '@anthonymelo',
      font: 'Georgia',
      size: 42,
      opacity: 0.85,
      position: 'bottom-right',
      color: '#ffffff',
      shadow: true,
      image: null,            // dataURL PNG da assinatura (logo/assinatura digitalizada)
    },
    apiKey: '',
    model: 'gpt-4o-mini',
    autoStyle: true,            // aplicar o último estilo às fotos novas
    lastStyle: null,            // snapshot do último estilo aplicado {type, name|factors|mode|prep|opacity}
  };

  return {
    get,
    set,
    loadSettings() {
      const saved = get('settings', {});
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        signature: { ...DEFAULT_SETTINGS.signature, ...(saved.signature || {}) },
      };
    },
    saveSettings(s) { set('settings', s); },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Storage;
