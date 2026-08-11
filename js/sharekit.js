/* ShareKit — compartilhamento de imagens com fallback em cascata.
 *
 * Função PURA pickShareStrategy: decide a melhor estratégia de compartilhamento
 * disponível no ambiente, do mais nativo ao mais universal:
 *   1. 'share'      → Web Share API (navigator.share + files) — Android/iOS/desktop
 *   2. 'clipboard'  → clipboard.write (imagem na área de transferência) — desktop
 *   3. 'download'   → download de arquivo (funciona em qualquer lugar, incl. Electron)
 *
 * Testável em Node (não toca em DOM).
 */
'use strict';

const ShareKit = (() => {
  function pickShareStrategy(nav) {
    if (nav && typeof nav.share === 'function') return 'share';
    if (nav && nav.clipboard && typeof nav.clipboard.write === 'function') return 'clipboard';
    return 'download';
  }

  return { pickShareStrategy };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ShareKit;
