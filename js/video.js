/* Exportação de vídeo (slideshow) — MediaRecorder nativo, ZERO dependência.
 *
 * Estratégia (PORQUÊ):
 *   · ffmpeg.wasm (~30MB) contradiz o ethos zero-bloat/offline → NÃO usar.
 *   · MediaRecorder + canvas.captureStream() é nativo do navegador (Chromium,
 *     Safari 14.5+, Electron): grava o canvas em tempo real sem servidor.
 *   · Custo: a gravação é TEMPO REAL (N fotos × delay). Para slideshow curto
 *     é aceitável; a UI mostra progresso ("Gerando vídeo: foto 2/5...").
 *   · Formato: MP4 (h264) se suportado, senão WebM (vp9 → vp8 → genérico).
 *
 * Funções PURAS (testáveis em Node):
 *   · pickVideoMime(isSupported) → melhor mimeType disponível (ou null)
 *   · videoExt(mime) → extensão do arquivo
 *
 * Função DOM (navegador):
 *   · exportVideo(canvas, mime, play) → Promise<Blob>; `play` recebe o canvas
 *     e desenha os frames aguardando o tempo de cada um.
 */
'use strict';

const Video = (() => {

  /* ------------------------------------------------------------ puro */

  /**
   * Escolhe o melhor mimeType de vídeo suportado pelo navegador.
   * Recebe `isSupported` (ex.: MediaRecorder.isTypeSupported.bind(MediaRecorder))
   * como parâmetro para ser testável em Node com mock.
   * Preferência: MP4/h264 (universal) → WebM/vp9 → WebM/vp8 → WebM genérico.
   */
  function pickVideoMime(isSupported) {
    if (typeof isSupported !== 'function') return null;
    const candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const m of candidates) {
      try {
        if (isSupported(m)) return m;
      } catch (_e) { /* isSupported pode lançar em navegadores exóticos */ }
    }
    return null;
  }

  /** Extensão do arquivo a partir do mimeType ('video/mp4...' → 'mp4'). */
  function videoExt(mime) {
    return mime && String(mime).indexOf('mp4') !== -1 ? 'mp4' : 'webm';
  }

  /* ------------------------------------------------------------ DOM */

  /**
   * Grava um vídeo do canvas. `play` é uma função assíncrona que desenha os
   * frames no canvas e aguarda o tempo de exibição; quando termina, a gravação
   * para e o Blob é resolvido.
   */
  function exportVideo(canvas, mime, play) {
    return new Promise((resolve, reject) => {
      let rec;
      let stream = null;
      try {
        stream = canvas.captureStream(30);
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      } catch (err) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        reject(err);
        return;
      }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onerror = () => {
        try { rec.stop(); } catch (_e) { /* já parado */ }
        stream.getTracks().forEach((t) => t.stop());
        reject(new Error('Falha na gravação do vídeo'));
      };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: mime });
        stream.getTracks().forEach((t) => t.stop());
        resolve(blob);
      };
      rec.start(200);
      Promise.resolve(play()).then(
        () => { if (rec.state !== 'inactive') rec.stop(); },
        (err) => {
          try { if (rec.state !== 'inactive') rec.stop(); } catch (_e) { /* ignore */ }
          stream.getTracks().forEach((t) => t.stop());
          reject(err);
        }
      );
    });
  }

  return { pickVideoMime, videoExt, exportVideo };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Video;
