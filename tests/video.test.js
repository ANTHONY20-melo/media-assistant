/* Testes do exportador de vídeo (js/video.js) — funções puras.
 *
 * A função DOM exportVideo exige canvas.captureStream + MediaRecorder
 * (navegador) → NÃO é testável em Node; as escolhas de formato (pickVideoMime)
 * e extensão (videoExt) são puras e cobertas aqui.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Video = require('../js/video.js');

test('pickVideoMime: prefere MP4/h264 quando suportado', () => {
  const supported = new Set(['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm']);
  const m = Video.pickVideoMime((x) => supported.has(x));
  assert.strictEqual(m, 'video/mp4;codecs=avc1.42E01E');
});

test('pickVideoMime: sem h264 cai para mp4 genérico', () => {
  const supported = new Set(['video/mp4', 'video/webm']);
  assert.strictEqual(Video.pickVideoMime((x) => supported.has(x)), 'video/mp4');
});

test('pickVideoMime: sem mp4 usa webm (vp9 → vp8 → genérico)', () => {
  const vp9 = new Set(['video/webm;codecs=vp9', 'video/webm']);
  assert.strictEqual(Video.pickVideoMime((x) => vp9.has(x)), 'video/webm;codecs=vp9');
  const vp8 = new Set(['video/webm;codecs=vp8', 'video/webm']);
  assert.strictEqual(Video.pickVideoMime((x) => vp8.has(x)), 'video/webm;codecs=vp8');
  const generic = new Set(['video/webm']);
  assert.strictEqual(Video.pickVideoMime((x) => generic.has(x)), 'video/webm');
});

test('pickVideoMime: nada suportado → null (sem vídeo)', () => {
  assert.strictEqual(Video.pickVideoMime(() => false), null);
});

test('pickVideoMime: isSupported que lança não explode (zero-trust)', () => {
  const m = Video.pickVideoMime(() => { throw new Error('boom'); });
  assert.strictEqual(m, null);
});

test('pickVideoMime: não-função → null', () => {
  assert.strictEqual(Video.pickVideoMime(undefined), null);
  assert.strictEqual(Video.pickVideoMime('mp4'), null);
});

test('videoExt: mime com mp4 → mp4', () => {
  assert.strictEqual(Video.videoExt('video/mp4;codecs=avc1.42E01E'), 'mp4');
  assert.strictEqual(Video.videoExt('video/mp4'), 'mp4');
});

test('videoExt: demais mimes → webm (fallback)', () => {
  assert.strictEqual(Video.videoExt('video/webm;codecs=vp9'), 'webm');
  assert.strictEqual(Video.videoExt('video/webm'), 'webm');
  assert.strictEqual(Video.videoExt(null), 'webm');
  assert.strictEqual(Video.videoExt(''), 'webm');
  assert.strictEqual(Video.videoExt(undefined), 'webm');
});
