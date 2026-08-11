/* App — orquestrador do Assistente de Mídia: estado, UI, carrossel,
 * histórico, análise JARVIS, legendas, assinatura e exportação. */
'use strict';

const App = (() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    docs: [],
    currentId: null,
    zoom: 1,
    zoomMode: 'fit', // 'fit' | 'manual'
    crop: null,       // { x, y, w, h } em px da imagem (quando ativo)
    cropRatio: null,  // 'free' | '1:1' | '4:5' | '16:9' | '3:2'
    cropZoomBefore: null,
    lastAnalysis: null,
    lastRecommendations: null,
    previewSignature: false,
    signImage: null, // HTMLImageElement da assinatura por imagem (quando mode='image')
    compare: false,       // overlay comparar antes/depois ativo
    comparePos: 0.5,      // posição do divisor (0..1)
    settings: Storage.loadSettings(),
  };

  /* ------------------------------------------------------------ helpers */

  function currentDoc() {
    return state.docs.find(d => d.id === state.currentId) || null;
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  /** Zoom que faz a foto caber no stage (com margem). */
  function computeFit() {
    const doc = currentDoc();
    const stage = $('stage');
    if (!doc || !stage) return 1;
    const availW = Math.max(60, stage.clientWidth - 32);
    const availH = Math.max(60, stage.clientHeight - 32);
    return Math.max(0.02, Math.min(1, availW / doc.current.width, availH / doc.current.height));
  }

  /** Extensão de arquivo do formato de exportação. */
  function ext(format) {
    return format === 'jpeg' ? 'jpg' : format || 'png';
  }

  function setZoom(z) {
    state.zoom = Math.max(0.05, Math.min(16, z));
    state.zoomMode = 'manual';
    render();
  }

  /* ------------------------------------------------------------ abas */

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabpage').forEach(p => {
      const isTarget = p.id === `tab-${name}`;
      p.classList.toggle('active', isTarget);
      p.classList.toggle('hidden', !isTarget);
    });
  }

  /* ------------------------------------------------------------ documentos */

  /* Documentos gigantes (ex.: 12MP do celular) esgotam a memória ao editar:
   * reduz o maior lado para 4096px no carregamento (qualidade visual preservada). */
  const MAX_DIM = 4096;

  function downscaleIfNeeded(img) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (Math.max(w, h) <= MAX_DIM) return img;
    const scale = MAX_DIM / Math.max(w, h);
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    let reduced = 0;
    for (const file of files) {
      try {
        const img = await loadImageFile(file);
        const out = downscaleIfNeeded(img);
        if (out !== img) reduced++;
        addDoc(out, file.name.replace(/\.[^.]+$/, ''));
      } catch (_e) {
        toast(`Não consegui abrir ${file.name}`);
      }
    }
    if (reduced) toast(`${reduced} foto(s) gigante(s) reduzida(s) para 4096px`);
    if (state.docs.length) {
      renderCarousel();
      selectDoc(state.docs[state.docs.length - 1].id);
      toast(`${state.docs.length} foto(s) no carrossel`);
    }
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function addDoc(img, name) {
    const original = Editor.fromImage(img);
    let current = Editor.clone(original);
    let styled = false;
    // estilo automático: aplica o último estilo às fotos novas (mantém o original na base)
    if (state.settings.autoStyle && state.settings.lastStyle) {
      try {
        current = Editor.applyStyle(original, state.settings.lastStyle);
        styled = true;
      } catch (_e) { /* estilo inválido/corrompido: usa o original */ }
    }
    const id = 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    state.docs.push({
      id, name,
      original,
      current,
      history: styled ? [Editor.clone(original), Editor.clone(current)] : [Editor.clone(original)], // base original no índice 0
      historyIdx: styled ? 1 : 0,
      thumb: makeThumb(current),
    });
  }

  function makeThumb(canvas) {
    const t = document.createElement('canvas');
    const max = 140;
    const scale = Math.min(1, max / Math.max(canvas.width, canvas.height));
    t.width = Math.max(1, Math.round(canvas.width * scale));
    t.height = Math.max(1, Math.round(canvas.height * scale));
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    return t;
  }

  function selectDoc(id) {
    if (state.crop) exitCrop(false);
    if (state.compare) exitCompare();
    state.currentId = id;
    state.zoomMode = 'fit';
    state.zoom = computeFit();
    state.lastAnalysis = null;
    state.lastRecommendations = null;
    hideDiagnosis();
    render();
    renderCarousel();
    $('emptyHint').style.display = 'none';
  }

  function closeDoc(id) {
    const idx = state.docs.findIndex(d => d.id === id);
    if (idx === -1) return;
    if (state.crop) exitCrop(false);
    if (state.compare) exitCompare();
    state.docs.splice(idx, 1);
    if (state.currentId === id) {
      const next = state.docs[Math.min(idx, state.docs.length - 1)];
      state.currentId = next ? next.id : null;
      state.lastAnalysis = null;
      state.lastRecommendations = null;
    }
    render();
    renderCarousel();
    if (!state.docs.length) $('emptyHint').style.display = 'flex';
  }

  /* ------------------------------------------------------------ seleção em lote */

  function toggleSelectDoc(id) {
    const doc = state.docs.find(d => d.id === id);
    if (!doc) return;
    doc._selected = !doc._selected;
    renderCarousel();
  }

  function selectedDocs() {
    return state.docs.filter(d => d._selected);
  }

  /* ------------------------------------------------------------ histórico */

  function commit(canvas) {
    const doc = currentDoc();
    if (!doc) return;
    // descarta o "refazer" e registra o novo estado (base original fica no [0])
    doc.history = doc.history.slice(0, doc.historyIdx + 1);
    doc.history.push(Editor.clone(canvas));
    if (doc.history.length > 26) {
      doc.history.shift();
      // o shift remove o [0] que era o ORIGINAL — restaura para o undo nunca perder a base
      doc.history[0] = Editor.clone(doc.original);
    }
    doc.historyIdx = doc.history.length - 1;
    doc.current = canvas;
    render();
  }

  function undo() {
    const doc = currentDoc();
    if (!doc || doc.historyIdx <= 0) return;
    doc.historyIdx--;
    doc.current = Editor.clone(doc.history[doc.historyIdx]);
    render();
  }

  function redo() {
    const doc = currentDoc();
    if (!doc || doc.historyIdx >= doc.history.length - 1) return;
    doc.historyIdx++;
    doc.current = Editor.clone(doc.history[doc.historyIdx]);
    render();
  }

  /* ------------------------------------------------------------ render */

  function render() {
    const doc = currentDoc();
    const canvas = $('stageCanvas');
    const empty = $('emptyHint');
    if (!doc) {
      canvas.style.display = 'none';
      empty.style.display = 'flex';
      $('btnExport').disabled = true;
      $('btnShare').disabled = true;
      $('btnCompare').disabled = true;
      $('zoomPct').textContent = '100%';
      drawHistogram();
      return;
    }
    empty.style.display = 'none';
    $('btnExport').disabled = false;
    $('btnShare').disabled = false;
    $('btnCompare').disabled = false;
    canvas.style.display = 'block';
    canvas.width = doc.current.width;
    canvas.height = doc.current.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(doc.current, 0, 0);
    if (state.previewSignature) {
      Editor.watermark(ctx, state.settings.signature, canvas.width, canvas.height, state.signImage);
    }
    const z = state.zoom;
    canvas.style.width = Math.max(1, Math.round(canvas.width * z)) + 'px';
    canvas.style.height = Math.max(1, Math.round(canvas.height * z)) + 'px';
    $('zoomPct').textContent = Math.round(z * 100) + '%';
    if (state.crop) positionCropOverlay();
    drawHistogram();
    if (state.compare) {
      // mantém o "depois" sempre atualizado (filtros/ações aplicados durante o compare)
      const after = $('compareAfter');
      if (after.width !== doc.current.width || after.height !== doc.current.height) {
        after.width = doc.current.width;
        after.height = doc.current.height;
      }
      after.getContext('2d').drawImage(doc.current, 0, 0);
      positionCompare();
    }
  }

  function renderCarousel() {
    const strip = $('carouselStrip');
    strip.innerHTML = '';
    for (const doc of state.docs) {
      const item = document.createElement('div');
      item.className = 'car-item' + (doc.id === state.currentId ? ' active' : '') + (doc._selected ? ' selected' : '');
      const img = document.createElement('img');
      img.src = doc.thumb.toDataURL();
      img.alt = doc.name;
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = doc.name.length > 16 ? doc.name.slice(0, 14) + '…' : doc.name;
      // botão de seleção por toque (mobile NÃO tem Ctrl+click — antes era impossível
      // escolher fotos distintas para colagem/multi no celular)
      const check = document.createElement('button');
      check.className = 'car-check' + (doc._selected ? ' check-on' : '');
      check.type = 'button';
      check.title = doc._selected ? 'Desselecionar' : 'Selecionar para colagem';
      check.textContent = doc._selected ? '✓' : '';
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSelectDoc(doc.id);
      });
      item.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          toggleSelectDoc(doc.id);
        } else {
          selectDoc(doc.id);
        }
      });
      item.append(check, img, name);
      // badge do melhor frame escolhido pelo JARVIS
      if (doc.id === state.bestFrameId) {
        const best = document.createElement('span');
        best.className = 'car-best';
        best.title = 'Melhor frame';
        best.textContent = '🏆';
        item.append(best);
      }
      strip.appendChild(item);
    }
    const selCount = state.docs.filter(d => d._selected).length;
    const clearBtn = $('btnClearSel');
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', selCount === 0);
      clearBtn.textContent = '✕ ' + (selCount ? selCount + ' sel.' : '');
    }
  }

  /* ------------------------------------------------------------ ajustes */

  const sliderToFactor = (v) => 1 + (v / 100);

  function adjustFromSliders() {
    return {
      brightness: sliderToFactor(+$('s-brightness').value),
      contrast: sliderToFactor(+$('s-contrast').value),
      saturation: sliderToFactor(+$('s-saturation').value),
      sharpness: sliderToFactor(+$('s-sharpness').value),
      temperature: (+$('s-temperature').value) / 100,
    };
  }

  function liveAdjust() {
    const doc = currentDoc();
    if (!doc) return;
    const preview = Editor.applyAdjust(doc.current, adjustFromSliders());
    const canvas = $('stageCanvas');
    canvas.width = preview.width;
    canvas.height = preview.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(preview, 0, 0);
    // replica o render(): preview de assinatura não pode sumir durante o ajuste ao vivo
    if (state.previewSignature) {
      Editor.watermark(ctx, state.settings.signature, canvas.width, canvas.height, state.signImage);
    }
    canvas.style.width = Math.max(1, Math.round(preview.width * state.zoom)) + 'px';
    canvas.style.height = Math.max(1, Math.round(preview.height * state.zoom)) + 'px';
  }

  function applyAdjust() {
    const doc = currentDoc();
    if (!doc) return;
    commit(Editor.applyAdjust(doc.current, adjustFromSliders()));
    setLastStyle({ type: 'adjust', factors: adjustFromSliders() });
    toast('Ajustes aplicados');
  }

  function resetAdjust() {
    ['s-brightness', 's-contrast', 's-saturation', 's-sharpness', 's-temperature']
      .forEach(id => { $(id).value = 0; $('v-' + id.replace('s-', '')).textContent = '0'; });
    render();
  }

  /* ------------------------------------------------------------ presets */

  function setSlidersFromFactors(factors) {
    const map = {
      brightness: 's-brightness', contrast: 's-contrast', saturation: 's-saturation',
      sharpness: 's-sharpness', temperature: 's-temperature',
    };
    const labelOf = id => 'v-' + id.replace('s-', '');
    Object.keys(map).forEach(k => {
      let v = factors[k] == null ? 0
        : k === 'temperature' ? Math.round(factors[k] * 100)
        : Math.round((factors[k] - 1) * 100);
      v = Math.max(-100, Math.min(100, v));
      $(map[k]).value = v;
      $(labelOf(map[k])).textContent = String(v);
    });
  }

  function applyPreset(key) {
    const doc = currentDoc();
    if (!doc) return toast('Abra uma foto primeiro');
    const factors = Editor.presetFactors(key);
    if (!factors) return;
    setSlidersFromFactors(factors);
    commit(Editor.applyPreset(doc.current, key));
    setLastStyle({ type: 'adjust', factors });
    toast('Preset "' + (Editor.PRESETS.find(p => p.key === key) || {}).label + '" aplicado');
  }

  function buildPresetBar() {
    const bar = $('presetBar');
    if (!bar) return;
    bar.innerHTML = '';
    const title = document.createElement('span');
    title.className = 'preset-title';
    title.textContent = 'Presets:';
    bar.appendChild(title);
    for (const p of Editor.PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset-btn';
      b.textContent = p.label;
      b.title = 'Aplicar ' + p.label;
      b.addEventListener('click', () => applyPreset(p.key));
      bar.appendChild(b);
    }
  }

  /* ------------------------------------------------------------ filtros */

  function buildFilterGrid() {
    const grid = $('filterGrid');
    grid.innerHTML = '';
    for (const [key, label] of Editor.FILTERS) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => applyFilter(key, label));
      grid.appendChild(b);
    }
  }

  function applyFilter(key, label) {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    if (key === 'original') {
      commit(Editor.clone(doc.original));
      setLastStyle(null);
      toast('Restaurado ao original');
      return;
    }
    commit(Editor.applyFilter(doc.current, key));
    setLastStyle({ type: 'filter', name: key });
    toast(`Filtro: ${label}`);
  }

  /* ------------------------------------------------------------ mesclagem */

  function doBlend() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    const mode = $('blendMode').value;
    const prep = $('blendPrep').value;
    const opacity = (+$('blendOpacity').value) / 100;
    commit(Editor.blend(doc.current, mode, prep, opacity));
    setLastStyle({ type: 'blend', mode, prep, opacity });
    toast(`Mesclagem: ${mode} + ${prep}`);
  }

  /* ------------------------------------------------------------ corte (crop) */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** Converte evento do mouse → coordenadas em px da IMAGEM (respeitando zoom). */
  function imgFromEvent(e) {
    const doc = currentDoc();
    const canvas = $('stageCanvas');
    const r = canvas.getBoundingClientRect();
    const z = state.zoom;
    return {
      x: clamp((e.clientX - r.left) / z, 0, doc.current.width),
      y: clamp((e.clientY - r.top) / z, 0, doc.current.height),
    };
  }

  /** Ajusta retângulo à proporção escolhida (mantém o centro). */
  function applyRatio(sel) {
    if (!state.cropRatio || state.cropRatio === 'free') return sel;
    const [rw, rh] = state.cropRatio.split(':').map(Number);
    const target = rw / rh;
    let { x, y, w, h } = sel;
    if (w / h > target) {
      const nw = h * target;
      x += (w - nw) / 2;
      w = nw;
    } else {
      const nh = w / target;
      y += (h - nh) / 2;
      h = nh;
    }
    return { x, y, w, h };
  }

  function clampCrop(sel, W, H) {
    sel.x = clamp(sel.x, 0, Math.max(0, W - 20));
    sel.y = clamp(sel.y, 0, Math.max(0, H - 20));
    sel.w = clamp(sel.w, 20, W - sel.x);
    sel.h = clamp(sel.h, 20, H - sel.y);
    return sel;
  }

  function startCrop() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    state.cropZoomBefore = { zoom: state.zoom, mode: state.zoomMode };
    state.zoomMode = 'fit';
    state.zoom = computeFit();
    state.crop = { x: 0, y: 0, w: doc.current.width, h: doc.current.height };
    state.cropRatio = 'free';
    setCropRatio('free');
    $('cropOverlay').classList.remove('hidden');
    positionCropOverlay();
    render();
    toast('Arraste para selecionar a área de corte ✂️');
  }

  function exitCrop(applied) {
    $('cropOverlay').classList.add('hidden');
    state.crop = null;
    state.cropRatio = null;
    if (state.cropZoomBefore) {
      state.zoom = state.cropZoomBefore.zoom;
      state.zoomMode = state.cropZoomBefore.mode;
      state.cropZoomBefore = null;
    }
    if (applied) toast('Corte aplicado ✂️');
    render();
  }

  function applyCrop() {
    const doc = currentDoc();
    if (!doc || !state.crop) return;
    const c = state.crop;
    commit(Editor.crop(doc.current, Math.round(c.x), Math.round(c.y), Math.round(c.w), Math.round(c.h)));
    exitCrop(true);
  }

  function setCropRatio(ratio) {
    state.cropRatio = ratio;
    document.querySelectorAll('.crop-bar [data-ratio]').forEach(b =>
      b.classList.toggle('active', b.dataset.ratio === ratio));
    if (state.crop) {
      state.crop = clampCrop(applyRatio(state.crop), currentDoc().current.width, currentDoc().current.height);
      positionCropOverlay();
    }
  }

  /** Posiciona a caixa de seleção e as sombras no stage (coordenadas da tela). */
  function positionCropOverlay() {
    if (!state.crop) return;
    const canvas = $('stageCanvas');
    const stage = $('stage');
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const L = cr.left - sr.left + state.crop.x * state.zoom;
    const T = cr.top - sr.top + state.crop.y * state.zoom;
    const W = state.crop.w * state.zoom;
    const H = state.crop.h * state.zoom;
    const box = $('cropBox');
    box.style.left = L + 'px';
    box.style.top = T + 'px';
    box.style.width = W + 'px';
    box.style.height = H + 'px';
    $('cropSize').textContent = `${Math.round(state.crop.w)} × ${Math.round(state.crop.h)} px`;
    const stageW = stage.clientWidth, stageH = stage.clientHeight;
    const shade = (el, l, t, w, h) => {
      el.style.left = l + 'px'; el.style.top = t + 'px';
      el.style.width = Math.max(0, w) + 'px'; el.style.height = Math.max(0, h) + 'px';
    };
    shade($('shadeTop'), 0, 0, stageW, T);
    shade($('shadeLeft'), 0, T, L, H);
    shade($('shadeRight'), L + W, T, stageW - L - W, H);
    shade($('shadeBottom'), 0, T + H, stageW, stageH - T - H);
  }

  let cropDrag = null; // { mode:'create'|'move'|'resize', sx, sy, ox, oy, ow, oh, handle }

  // Pointer Events: cobrem mouse E touch no celular com o mesmo handler
  function onCropPointerDown(e) {
    if (!state.crop) return;
    e.preventDefault();
    e.stopPropagation();
    const p = imgFromEvent(e);
    const c = state.crop;
    const handle = e.target && e.target.dataset ? e.target.dataset.h : null;
    if (handle) {
      cropDrag = { mode: 'resize', handle, sx: p.x, sy: p.y, ox: c.x, oy: c.y, ow: c.w, oh: c.h };
    } else if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) {
      cropDrag = { mode: 'move', sx: p.x, sy: p.y, ox: c.x, oy: c.y };
    } else {
      cropDrag = { mode: 'create', sx: p.x, sy: p.y };
    }
    window.addEventListener('pointermove', onCropPointerMove);
    window.addEventListener('pointerup', onCropPointerUp);
    window.addEventListener('pointercancel', onCropPointerUp);
  }

  function resizeFromHandle(d, p, W, H) {
    let { ox, oy, ow, oh } = d;
    const right = ox + ow, bottom = oy + oh;
    let x = ox, y = oy, w = ow, h = oh;
    if (d.handle.includes('e')) w = clamp(p.x - ox, 20, W - ox);
    if (d.handle.includes('s')) h = clamp(p.y - oy, 20, H - oy);
    if (d.handle.includes('w')) { x = clamp(p.x, 0, right - 20); w = right - x; }
    if (d.handle.includes('n')) { y = clamp(p.y, 0, bottom - 20); h = bottom - y; }
    return { x, y, w, h };
  }

  function onCropPointerMove(e) {
    if (!cropDrag) return;
    e.preventDefault();
    const doc = currentDoc();
    const p = imgFromEvent(e);
    const W = doc.current.width, H = doc.current.height;
    if (cropDrag.mode === 'create') {
      let x = Math.min(cropDrag.sx, p.x), y = Math.min(cropDrag.sy, p.y);
      let w = Math.max(20, Math.abs(p.x - cropDrag.sx));
      let h = Math.max(20, Math.abs(p.y - cropDrag.sy));
      state.crop = clampCrop(applyRatio({ x, y, w, h }), W, H);
    } else if (cropDrag.mode === 'move') {
      state.crop.x = clamp(cropDrag.ox + p.x - cropDrag.sx, 0, W - state.crop.w);
      state.crop.y = clamp(cropDrag.oy + p.y - cropDrag.sy, 0, H - state.crop.h);
    } else {
      state.crop = clampCrop(applyRatio(resizeFromHandle(cropDrag, p, W, H)), W, H);
    }
    positionCropOverlay();
  }

  function onCropPointerUp() {
    window.removeEventListener('pointermove', onCropPointerMove);
    window.removeEventListener('pointerup', onCropPointerUp);
    window.removeEventListener('pointercancel', onCropPointerUp);
    cropDrag = null;
  }

  /* ------------------------------------------------------------ comparar antes/depois */

  function toggleCompare() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    state.compare = !state.compare;
    if (state.compare) {
      rebuildCompare();
      positionCompare();
      $('compareOverlay').classList.remove('hidden');
      toast('Comparando: arraste o divisor ↔');
    } else {
      exitCompare();
    }
  }

  function exitCompare() {
    state.compare = false;
    $('compareOverlay').classList.add('hidden');
  }

  /** Copia original (antes) e atual (depois) para os canvases do comparador. */
  function rebuildCompare() {
    const doc = currentDoc();
    if (!doc) return;
    const before = $('compareBefore');
    const after = $('compareAfter');
    before.width = doc.original.width;
    before.height = doc.original.height;
    before.getContext('2d').drawImage(doc.original, 0, 0);
    after.width = doc.current.width;
    after.height = doc.current.height;
    after.getContext('2d').drawImage(doc.current, 0, 0);
  }

  /** Posiciona os canvases/handle do comparador sobre o stage (coordenadas da tela). */
  function positionCompare() {
    const doc = currentDoc();
    if (!doc || !state.compare) return;
    const canvas = $('stageCanvas');
    const stage = $('stage');
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const L = cr.left - sr.left;
    const T = cr.top - sr.top;
    const W = cr.width;
    const H = cr.height;
    const pos = Math.max(0, Math.min(1, state.comparePos));
    const before = $('compareBefore');
    const after = $('compareAfter');
    for (const cv of [before, after]) {
      cv.style.left = L + 'px';
      cv.style.top = T + 'px';
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
    }
    // o "antes" aparece à esquerda do divisor (inset no lado direito)
    before.style.clipPath = `inset(0 ${(1 - pos) * 100}% 0 0)`;
    const handle = $('compareHandle');
    handle.style.left = (L + W * pos) + 'px';
  }

  let compareDrag = false;

  function onComparePointerDown(e) {
    if (!state.compare) return;
    e.preventDefault();
    e.stopPropagation();
    compareDrag = true;
    window.addEventListener('pointermove', onComparePointerMove);
    window.addEventListener('pointerup', onComparePointerUp);
    window.addEventListener('pointercancel', onComparePointerUp);
  }

  function onComparePointerMove(e) {
    if (!state.compare || !compareDrag) return;
    e.preventDefault();
    const stage = $('stage');
    const sr = stage.getBoundingClientRect();
    const canvas = $('stageCanvas');
    const cr = canvas.getBoundingClientRect();
    const L = cr.left - sr.left;
    state.comparePos = cr.width > 0 ? clamp((e.clientX - (sr.left + L)) / cr.width, 0, 1) : 0.5;
    positionCompare();
  }

  function onComparePointerUp() {
    compareDrag = false;
    window.removeEventListener('pointermove', onComparePointerMove);
    window.removeEventListener('pointerup', onComparePointerUp);
    window.removeEventListener('pointercancel', onComparePointerUp);
  }

  /* ------------------------------------------------------------ histograma */

  /** Desenha o histograma de luminância da foto atual na aba Ajustes. */
  function drawHistogram() {
    const cv = $('histogramCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const doc = currentDoc();
    if (!doc) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      return;
    }
    const hist = Editor.histOf(Editor.toImageData(doc.current));
    const bars = Editor.histToBars(hist, cv.width);
    const max = Math.max(1, ...bars);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const barW = cv.width / bars.length;
    for (let i = 0; i < bars.length; i++) {
      const h = Math.max(1, Math.round((bars[i] / max) * (cv.height - 4)));
      ctx.fillStyle = i < bars.length / 2 ? '#2D4A6E' : '#1B2637';
      ctx.fillRect(i * barW + 1, cv.height - h, Math.max(1, barW - 2), h);
    }
  }

  /* ------------------------------------------------------------ análise JARVIS */

  function hideDiagnosis() {
    $('diagnosis').classList.add('hidden');
    $('diagnosis').innerHTML = '';
    $('correctionBox').classList.add('hidden');
    $('correctionBox').innerHTML = '';
    $('recommendationsBox').classList.add('hidden');
    $('recommendationsBox').innerHTML = '';
    $('captions').classList.add('hidden');
    $('captions').innerHTML = '';
  }

  function analyzeCurrent() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    const analysis = Analyzer.analyze(Editor.toImageData(doc.current));
    state.lastAnalysis = analysis;
    state.lastRecommendations = Analyzer.recommend(analysis);
    renderDiagnosis(analysis);
    renderRecommendations(analysis);
    generateCaptions();
    toast('Análise JARVIS concluída ✨');
  }

  function renderDiagnosis(a) {
    const box = $('diagnosis');
    box.innerHTML = '';
    const diag = Analyzer.diagnose(a);
    box.classList.remove('hidden');

    // opinião do JARVIS
    const opinionEl = document.createElement('div');
    opinionEl.className = 'diag-opinion';
    opinionEl.innerHTML = Analyzer.opinion(a);
    box.appendChild(opinionEl);

    const score = document.createElement('div');
    score.className = 'diag-score';
    score.innerHTML = `Nota da foto: <b>${diag.score}/100</b> <small>(${a.width}×${a.height}px · ${a.mood})</small>`;
    box.appendChild(score);

    for (const item of diag.items) {
      const el = document.createElement('div');
      el.className = 'diag-item ' + item.level;
      el.innerHTML = `<span>${item.level === 'ok' ? '✅' : item.level === 'warn' ? '⚠️' : '🔴'}</span><span>${item.text}</span>`;
      box.appendChild(el);
    }

    const corr = $('correctionBox');
    corr.classList.remove('hidden');
    corr.innerHTML = '<button id="btnAutoEnhance" class="accent">🎯 Aplicar correção ideal</button>';
    $('btnAutoEnhance').addEventListener('click', applyAutoEnhance);
  }

  function renderRecommendations(a) {
    const recs = state.lastRecommendations;
    if (!recs || !recs.length) return;
    const box = $('recommendationsBox');
    box.innerHTML = '';
    box.classList.remove('hidden');

    const title = document.createElement('h4');
    title.textContent = '💡 Sugestões do JARVIS';
    box.appendChild(title);

    for (const rec of recs) {
      const card = document.createElement('div');
      card.className = 'rec-card';
      const icon = rec.type === 'filter' ? '🎨' : rec.type === 'adjust' ? '⚙️' : rec.type === 'compose' ? '📐' : rec.type === 'caption' ? '💬' : '📤';
      card.innerHTML = `<span class="rec-icon">${icon}</span><div><strong>${rec.label}</strong><small>${rec.reason}</small></div>`;
      // recomendações de filtro têm `filter` sem `action` — o botão aplica ambos
      if (rec.filter || rec.action) {
        const btn = document.createElement('button');
        btn.textContent = 'Aplicar';
        btn.className = 'ghost';
        btn.addEventListener('click', () => {
          if (rec.filter) {
            const doc = currentDoc();
            if (doc) { commit(Editor.applyFilter(doc.current, rec.filter)); setLastStyle({ type: 'filter', name: rec.filter }); toast(`Filtro: ${rec.label}`); }
          } else if (rec.action.brightness || rec.action.contrast || rec.action.saturation || rec.action.sharpness) {
            const doc = currentDoc();
            if (doc) { commit(Editor.applyAdjust(doc.current, rec.action)); setLastStyle({ type: 'adjust', factors: rec.action }); toast('Ajuste aplicado'); }
          }
        });
        card.appendChild(btn);
      }
      box.appendChild(card);
    }
  }

  function applyAutoEnhance() {
    const doc = currentDoc();
    if (!doc || !state.lastAnalysis) return;
    commit(Editor.autoEnhance(doc.current, state.lastAnalysis));
    setLastStyle({ type: 'auto' });
    toast('Correção ideal aplicada pelo JARVIS 🎯');
  }

  /* ------------------------------------------------------------ estilo automático */

  /** Grava o último estilo usado (para aplicar às fotos novas) e atualiza a badge. */
  function setLastStyle(style) {
    state.settings.lastStyle = style;
    Storage.saveSettings(state.settings);
    updateStyleBadge();
  }

  /** Atualiza a badge "Último estilo: ..." da aba Ajustes. */
  function updateStyleBadge() {
    const badge = $('styleBadge');
    if (!badge) return;
    const label = Editor.styleLabel(state.settings.lastStyle);
    badge.textContent = label ? 'Último estilo: ' + label : 'Nenhum estilo ainda';
    badge.classList.toggle('badge-empty', !label);
  }

  function clearLastStyle() {
    state.settings.lastStyle = null;
    Storage.saveSettings(state.settings);
    updateStyleBadge();
    toast('Estilo automático limpo');
  }

  /* ------------------------------------------------------------ molduras */

  // categoriza as molduras para render no grid
  const FRAME_CATEGORIES = [
    { name: 'Bordas', keys: ['none', 'classic', 'polaroid', 'film', 'double', 'vintage', 'neon', 'gradient', 'shadow', 'rounded'] },
    { name: 'Recortes (shaped)', keys: ['heart', 'circle', 'oval', 'star', 'hexagon'] },
    { name: 'Colagens (multi)', keys: ['grid-2x2', 'grid-1x2', 'grid-2x1', 'diptych', 'triptych', 'collage-3', 'collage-4', 'collage-5'] },
  ];
  const SHAPE_KEYS = new Set(['heart', 'circle', 'oval', 'star', 'hexagon']);
  const MULTI_KEYS = new Set(['grid-2x2', 'grid-1x2', 'grid-2x1', 'diptych', 'triptych', 'collage-3', 'collage-4', 'collage-5']);

  function buildFrameGrid() {
    const grid = $('frameGrid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.classList.add('category-grid');
    for (const cat of FRAME_CATEGORIES) {
      const header = document.createElement('div');
      header.className = 'frame-category';
      header.textContent = cat.name;
      grid.appendChild(header);
      const row = document.createElement('div');
      row.className = 'frame-row';
      for (const key of cat.keys) {
        const b = document.createElement('button');
        b.dataset.frame = key;
        b.textContent = Editor.FRAME_LABELS[key];
        b.title = Editor.FRAME_LABELS[key];
        if (MULTI_KEYS.has(key)) b.classList.add('frame-multi');
        b.addEventListener('click', () => applyFrameAction(key));
        row.appendChild(b);
      }
      grid.appendChild(row);
    }
  }

  function applyFrameAction(key) {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    if (key === 'none') {
      commit(Editor.clone(doc.current));
      setLastStyle(null);
      toast('Moldura removida');
      return;
    }
    // multi-slot: usa as fotos selecionadas (ou replicam a atual)
    if (MULTI_KEYS.has(key)) {
      const sel = selectedDocs();
      if (!sel.length) {
        toast(`Toque no ✓ das fotos para escolher (${Editor.FRAME_LABELS[key]}). Usando a foto atual.`);
      }
      const photos = sel.length > 0 ? sel.map(s => s.current) : [doc.current];
      const result = Editor.applyFrameMulti(doc.current, key, photos);
      commit(result);
      toast(`Colagem: ${Editor.FRAME_LABELS[key]} (${photos.length} foto${photos.length > 1 ? 's' : ''})`);
      return;
    }
    // shaped: recorta a foto na forma
    if (SHAPE_KEYS.has(key)) {
      const result = Editor.applyFrame(doc.current, key);
      commit(result);
      setLastStyle({ type: 'frame', name: key });
      toast(`Moldura: ${Editor.FRAME_LABELS[key]}`);
      return;
    }
    // bordas clássicas
    commit(Editor.applyFrame(doc.current, key));
    setLastStyle({ type: 'frame', name: key });
    toast(`Moldura: ${Editor.FRAME_LABELS[key]}`);
  }

  /* ------------------------------------------------------------ operações em lote */

  function batchApplyAdjust() {
    const selected = selectedDocs();
    const target = selected.length > 0 ? selected : state.docs;
    if (!target.length) { toast('Selecione fotos no carrossel (Ctrl+click)'); return; }
    if (!state.lastAnalysis) { toast('Analise uma foto primeiro para usar os mesmos ajustes'); return; }
    for (const doc of target) {
      const enhanced = Editor.autoEnhance(doc.current, state.lastAnalysis);
      // mesmo modelo do commit(): preserva a base original no [0] e o undo/redo em cadeia
      doc.history = doc.history.slice(0, doc.historyIdx + 1);
      doc.history.push(Editor.clone(enhanced));
      if (doc.history.length > 26) {
        doc.history.shift();
        doc.history[0] = Editor.clone(doc.original);
      }
      doc.historyIdx = doc.history.length - 1;
      doc.current = enhanced;
    }
    render();
    renderCarousel();
    setLastStyle({ type: 'auto' });
    toast(`Ajustes aplicados em ${target.length} foto(s)`);
  }

  /**
   * Exporta GIF animado (encoder próprio js/gif.js) usando as fotos do
   * carrossel: selecionadas ou todas. Frames normalizados no canvas base do
   * MAIOR tamanho (letterbox branco) — fotos de tamanhos diferentes cabem.
   */
  function exportGIF(docs) {
    if (!docs.length) { toast('Nenhuma foto para exportar'); return; }
    if (docs.length < 2) { toast('Adicione 2+ fotos para gerar um GIF animado'); return; }
    const w = Math.max(...docs.map(d => d.current.width));
    const h = Math.max(...docs.map(d => d.current.height));
    const frames = [];
    for (const doc of docs) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      const fw = doc.current.width, fh = doc.current.height;
      const scale = Math.min(w / fw, h / fh);
      const dw = fw * scale, dh = fh * scale;
      ctx.drawImage(doc.current, (w - dw) / 2, (h - dh) / 2, dw, dh);
      frames.push(Editor.toImageData(c));
    }
    const bytes = GIF.encodeGIF(w, h, frames, GIF.normalizeDelay($('gifDelay') ? $('gifDelay').value : 600));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    download(new Blob([bytes], { type: 'image/gif' }), `slideshow-jarvis-${stamp}.gif`);
    toast(`GIF gerado com ${docs.length} fotos ✓ (${GIF.normalizeDelay($('gifDelay') ? $('gifDelay').value : 600)}ms/foto)`);
  }

  /** Mostra o campo de delay do GIF só quando o formato selecionado é GIF. */
  function syncGifDelayVisibility() {
    const wrap = $('gifDelayWrap');
    if (wrap) wrap.classList.toggle('hidden', $('exportFormat').value !== 'gif');
  }

  /**
   * JARVIS escolhe o melhor frame do carrossel: analisa cada foto
   * (Analyzer.analyze + diagnose) e marca a de maior score com badge 🏆.
   */
  function rankBestFrame() {
    if (state.docs.length < 2) { toast('Adicione 2+ fotos para o JARVIS comparar'); return; }
    const ranked = Analyzer.rankFrames(state.docs.map(d => Editor.toImageData(d.current)));
    if (!ranked.length) { toast('Não foi possível avaliar as fotos'); return; }
    const best = ranked[0];
    state.bestFrameId = state.docs[best.index].id;
    renderCarousel();
    toast(`🏆 Melhor frame: ${state.docs[best.index].name} — nota ${best.score}`);
  }

  function exportAll() {
    const docs = selectedDocs().length > 0 ? selectedDocs() : state.docs;
    if (!docs.length) { toast('Nenhuma foto para exportar'); return; }
    const format = $('exportFormat').value;
    if (format === 'gif') { exportGIF(docs); return; }
    const sig = state.settings.signature;
    let count = 0, failed = 0;
    for (const doc of docs) {
      Editor.exportCanvas(doc.current, format, quality(format), sig, sig.enabled, (blob) => {
        if (!blob) {
          failed++;
          toast(`Falha ao exportar ${doc.name}`);
        } else {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          download(blob, `${doc.name}-jarvis-${stamp}.${ext(format)}`);
          count++;
        }
        if (count + failed === docs.length) {
          toast(failed ? `${count} exportada(s), ${failed} falha(s)` : `${count} foto(s) exportada(s)`);
        }
      }, state.signImage);
    }
  }

  /* ------------------------------------------------------------ legendas */

  function generateCaptions() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    if (!state.lastAnalysis) state.lastAnalysis = Analyzer.analyze(Editor.toImageData(doc.current));

    const place = $('captionPlace').value;
    const style = $('captionStyle').value;
    const list = Captions.generate(state.lastAnalysis, { style, place });
    renderCaptions(list, state.lastAnalysis);
  }

  function renderCaptions(list, analysis) {
    const box = $('captions');
    box.innerHTML = '';
    box.classList.remove('hidden');
    for (const text of list) {
      const card = document.createElement('div');
      card.className = 'caption-card';
      const p = document.createElement('div');
      p.className = 'caption-text';
      p.textContent = text;
      const actions = document.createElement('div');
      actions.className = 'caption-actions';
      const copy = document.createElement('button');
      copy.textContent = '📋 Copiar';
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(text).then(() => toast('Legenda copiada!'));
      });
      const reuse = document.createElement('button');
      reuse.textContent = '🔄 Outra';
      reuse.addEventListener('click', () => generateCaptions());
      actions.append(copy, reuse);
      card.append(p, actions);
      box.appendChild(card);
    }
  }

  async function aiCaption() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    if (!state.lastAnalysis) state.lastAnalysis = Analyzer.analyze(Editor.toImageData(doc.current));
    const s = state.settings;
    if (!s.apiKey) {
      toast('Coloque sua chave de API na aba Assinatura → API');
      switchTab('sign');
      return;
    }
    const btn = $('btnAiCaption');
    btn.disabled = true;
    btn.textContent = '⏳ Gerando…';
    try {
      const text = await AI.generateCaption(state.lastAnalysis, s, {
        style: $('captionStyle').value,
        place: $('captionPlace').value,
      });
      if (text) renderCaptions([text], state.lastAnalysis);
      else toast('IA não retornou texto');
    } catch (err) {
      toast(err.message || 'Falha na IA');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Com IA';
    }
  }

  /* ------------------------------------------------------------ assinatura */

  /** Lê um arquivo de imagem da assinatura, reduz para ≤300px e devolve dataURL. */
  function readSignImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = 300;
        const scale = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round((img.naturalWidth || 0) * scale));
        c.height = Math.max(1, Math.round((img.naturalHeight || 0) * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  /** Cria o HTMLImageElement usado pelo watermark/preview a partir de um dataURL. */
  function loadSignImage(dataURL) {
    if (!dataURL) { state.signImage = null; return Promise.resolve(null); }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { state.signImage = img; resolve(img); };
      img.onerror = () => { state.signImage = null; resolve(null); };
      img.src = dataURL;
    });
  }

  function toggleSignFields() {
    const imageMode = document.querySelector('input[name="signMode"]:checked').value === 'image';
    $('signTextFields').classList.toggle('hidden', imageMode);
    $('signImageFields').classList.toggle('hidden', !imageMode);
    $('signColorRow').classList.toggle('hidden', imageMode);
    $('signShadowRow').classList.toggle('hidden', !imageMode);
  }

  function bindSignatureInputs() {
    const from = () => {
      const sig = state.settings.signature;
      $('signEnabled').checked = sig.enabled;
      $('signMode' + (sig.mode === 'image' ? 'Image' : 'Text')).checked = true;
      $('signText').value = sig.text;
      $('signFont').value = sig.font;
      $('signSize').value = sig.size;
      $('v-signSize').textContent = sig.size;
      $('signOpacity').value = Math.round(sig.opacity * 100);
      $('v-signOpacity').textContent = Math.round(sig.opacity * 100);
      $('signPosition').value = sig.position;
      $('signColor').value = sig.color;
      $('signColorHex').textContent = sig.color;
      $('signShadow').checked = sig.shadow;
      $('signApiKey').value = state.settings.apiKey || '';
      $('signModel').value = state.settings.model || 'gpt-4o-mini';
      toggleSignFields();
      if (sig.image) {
        loadSignImage(sig.image).then(showSignImagePreview);
      } else {
        hideSignImagePreview();
      }
    };
    const to = () => ({
      enabled: $('signEnabled').checked,
      mode: document.querySelector('input[name="signMode"]:checked').value,
      text: $('signText').value.trim(),
      font: $('signFont').value,
      size: Math.max(10, +$('signSize').value || 42),
      opacity: (+$('signOpacity').value || 85) / 100,
      position: $('signPosition').value,
      color: $('signColor').value,
      shadow: $('signShadow').checked,
      image: state.settings.signature.image || null,
    });
    const syncVals = () => {
      $('v-signSize').textContent = $('signSize').value;
      $('v-signOpacity').textContent = $('signOpacity').value;
      $('signColorHex').textContent = $('signColor').value;
    };
    const updateLive = () => {
      // Atualiza state.settings.signature em tempo real para preview/exportação imediata
      state.settings.signature = to();
      if (state.previewSignature) render();
    };
    // Sincroniza displays e atualiza estado ao vivo em qualquer mudança
    ['signEnabled', 'signText', 'signFont', 'signSize', 'signOpacity', 'signPosition', 'signColor', 'signShadow'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('input', () => { syncVals(); updateLive(); });
    });
    document.querySelectorAll('input[name="signMode"]').forEach(r =>
      r.addEventListener('change', () => { toggleSignFields(); updateLive(); }));

    // upload da imagem da assinatura
    $('btnSignImageUpload').addEventListener('click', () => $('signImageInput').click());
    $('signImageInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const dataURL = await readSignImage(file);
        state.settings.signature.image = dataURL;
        await loadSignImage(dataURL);
        showSignImagePreview();
        updateLive();
        toast('Assinatura em imagem carregada ✓');
      } catch (_err) {
        toast('Não consegui ler essa imagem');
      }
    });
    $('btnSignImageRemove').addEventListener('click', () => {
      state.settings.signature.image = null;
      state.signImage = null;
      hideSignImagePreview();
      updateLive();
      toast('Assinatura em imagem removida');
    });

    // Botão "Salvar padrão" persiste no localStorage
    $('btnSignSave').addEventListener('click', () => {
      Storage.saveSettings(state.settings);
      toast('Assinatura salva no navegador');
    });
    $('btnApiSave').addEventListener('click', () => {
      state.settings.apiKey = $('signApiKey').value.trim();
      state.settings.model = $('signModel').value;
      Storage.saveSettings(state.settings);
      toast('Chave de API salva (fica só no seu navegador)');
    });
    $('btnSignPreview').addEventListener('click', () => {
      state.previewSignature = !state.previewSignature;
      render();
      toast(state.previewSignature ? 'Assinatura visível no preview' : 'Assinatura oculta no preview');
    });
    from();
  }

  function showSignImagePreview() {
    const p = $('signImagePreview');
    p.classList.remove('hidden');
    const img = $('signImagePreviewImg');
    img.src = state.settings.signature.image || '';
    img.alt = 'Assinatura (imagem)';
  }

  function hideSignImagePreview() {
    $('signImagePreview').classList.add('hidden');
    $('signImagePreviewImg').src = '';
  }

  /* ------------------------------------------------------------ export */

  function quality(format) {
    return format === 'png' ? 1 : 0.92;
  }

  function exportCurrent() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    const format = $('exportFormat').value;
    // GIF animado: usa o carrossel (selecionadas ou todas) — uma foto só vira aviso
    if (format === 'gif') {
      const docs = selectedDocs().length > 0 ? selectedDocs() : state.docs;
      exportGIF(docs);
      return;
    }
    const sig = state.settings.signature;
    Editor.exportCanvas(doc.current, format, quality(format), sig, sig.enabled, (blob) => {
      if (!blob) { toast('Falha ao exportar'); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(blob, `${doc.name}-jarvis-${stamp}.${ext(format)}`);
      toast('Exportado com assinatura ✓');
    }, state.signImage);
  }

  /* ------------------------------------------------------------ compartilhar */

  /** Compartilha a foto atual: Web Share nativo → clipboard → download (cascata). */
  function shareCurrent() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    const format = $('exportFormat').value;
    // GIF animado: share/clipboard não fazem sentido → download direto
    if (format === 'gif') {
      const docs = selectedDocs().length > 0 ? selectedDocs() : state.docs;
      exportGIF(docs);
      return;
    }
    const sig = state.settings.signature;
    const strategy = ShareKit.pickShareStrategy(navigator);
    Editor.exportCanvas(doc.current, format, quality(format), sig, sig.enabled, async (blob) => {
      if (!blob) { toast('Falha ao exportar'); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `${doc.name}-jarvis-${stamp}.${ext(format)}`;

      // 1) Web Share API (nativo do celular/desktop) — pode cancelar (AbortError = silêncio)
      if (strategy === 'share') {
        try {
          const file = new File([blob], filename, { type: blob.type });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: doc.name });
            toast('Compartilhado ✓');
            return;
          }
        } catch (err) {
          if (err.name === 'AbortError') return; // usuário cancelou — não é erro
        }
        // sem suporte a arquivos ou falha: cai no clipboard/download
      }

      // 2) clipboard (imagem) — só para PNG; se falhar cai no download
      if (strategy === 'clipboard' && format === 'png') {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('Imagem copiada! Cole onde quiser');
          return;
        } catch (_e) { /* permissão negada → download */ }
      }

      // 3) download universal (funciona em qualquer ambiente, incl. Electron)
      download(blob, filename);
      toast('Imagem baixada ✓');
    }, state.signImage);
  }

  /* ------------------------------------------------------------ eventos */

  function bindEvents() {
    $('btnOpen').addEventListener('click', () => $('fileInput').click());
    $('btnAdd').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('btnExport').addEventListener('click', exportCurrent);
    $('btnShare').addEventListener('click', shareCurrent);
    $('exportFormat').addEventListener('change', syncGifDelayVisibility);
    $('btnBestFrame').addEventListener('click', rankBestFrame);
    $('btnClose').addEventListener('click', () => currentDoc() && closeDoc(currentDoc().id));
    $('btnClearSel').addEventListener('click', () => {
      for (const d of state.docs) d._selected = false;
      renderCarousel();
    });
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);

    $('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
    $('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
    $('btnZoomFit').addEventListener('click', () => { state.zoomMode = 'fit'; state.zoom = computeFit(); render(); });
    $('btnCompare').addEventListener('click', toggleCompare);
    $('compareOverlay').addEventListener('pointerdown', onComparePointerDown);
    window.addEventListener('resize', () => {
      if (state.zoomMode === 'fit' && currentDoc()) {
        state.zoom = computeFit();
        render();
      }
    });

    $('btnCrop').addEventListener('click', startCrop);
    $('btnCropReset').addEventListener('click', () => {
      const doc = currentDoc();
      if (!doc) { toast('Abra uma foto primeiro'); return; }
      commit(Editor.clone(doc.original));
      toast('Restaurado ao original');
    });
    $('cropCancel').addEventListener('click', () => exitCrop(false));
    $('cropApply').addEventListener('click', applyCrop);
    document.querySelectorAll('.crop-bar [data-ratio]').forEach(b =>
      b.addEventListener('click', () => setCropRatio(b.dataset.ratio)));
    $('cropOverlay').addEventListener('pointerdown', onCropPointerDown);

    $('btnAbout').addEventListener('click', () => {
      alert('🤖 JARVIS Studio — Assistente de Mídia\n\n' +
        'Analise, corrija, gere legendas e assine suas fotos.\n' +
        'Ctrl+click no carrossel para selecionar múltiplas.\n' +
        '100% offline. Por JARVIS para Anthony Melo.');
    });

    document.querySelectorAll('.tab').forEach(b =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)));

    ['brightness', 'contrast', 'saturation', 'sharpness', 'temperature'].forEach(k => {
      const el = $('s-' + k);
      el.addEventListener('input', () => {
        $('v-' + k).textContent = el.value;
        liveAdjust();
      });
    });
    $('btnApplyAdjust').addEventListener('click', applyAdjust);
    $('btnResetAdjust').addEventListener('click', resetAdjust);

    $('blendOpacity').addEventListener('input', () => $('v-blendOpacity').textContent = $('blendOpacity').value);
    $('btnBlend').addEventListener('click', doBlend);

    // estilo automático
    $('autoStyleToggle').addEventListener('change', (e) => {
      state.settings.autoStyle = e.target.checked;
      Storage.saveSettings(state.settings);
      toast(e.target.checked ? 'Estilo automático ativado' : 'Estilo automático desativado');
    });
    $('btnClearStyle').addEventListener('click', clearLastStyle);

    $('btnAnalyze').addEventListener('click', analyzeCurrent);
    $('btnAnalyzeTab').addEventListener('click', analyzeCurrent);
    $('btnCaptions').addEventListener('click', generateCaptions);
    $('btnAiCaption').addEventListener('click', aiCaption);

    bindSignatureInputs();

    // batch operations
    const btnBatchEnhance = $('btnBatchEnhance');
    if (btnBatchEnhance) btnBatchEnhance.addEventListener('click', batchApplyAdjust);
    const btnBatchExport = $('btnBatchExport');
    if (btnBatchExport) btnBatchExport.addEventListener('click', exportAll);

    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); exportCurrent(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    });
  }

  /* ------------------------------------------------------------ init */

  function init() {
    bindEvents();
    buildFilterGrid();
    buildFrameGrid();
    buildPresetBar();
    syncGifDelayVisibility();
    updateStyleBadge();
    $('autoStyleToggle').checked = !!state.settings.autoStyle;
    render();
    renderCarousel();
    $('btnExport').disabled = true;
    $('btnShare').disabled = true;
    $('btnCompare').disabled = true;
    // PWA offline: registra o service worker só em HTTPS ou localhost
    // (nunca em file:// — ex.: versão desktop/Electron — para não duplicar cache)
    if (('serviceWorker' in navigator) &&
        (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline/browser antigo: app funciona sem SW */ });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return { addFiles, analyzeCurrent, generateCaptions, exportCurrent, exportAll };
})();
