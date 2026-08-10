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
    const id = 'doc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    state.docs.push({
      id, name,
      original,
      current: Editor.clone(original),
      history: [Editor.clone(original)], // base original no índice 0
      historyIdx: 0,
      thumb: makeThumb(original),
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
      $('zoomPct').textContent = '100%';
      return;
    }
    empty.style.display = 'none';
    $('btnExport').disabled = false;
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
      item.append(img, name);
      item.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) {
          toggleSelectDoc(doc.id);
        } else {
          selectDoc(doc.id);
        }
      });
      strip.appendChild(item);
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
    toast('Ajustes aplicados');
  }

  function resetAdjust() {
    ['s-brightness', 's-contrast', 's-saturation', 's-sharpness', 's-temperature']
      .forEach(id => { $(id).value = 0; $('v-' + id.replace('s-', '')).textContent = '0'; });
    render();
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
      toast('Restaurado ao original');
      return;
    }
    commit(Editor.applyFilter(doc.current, key));
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
            if (doc) { commit(Editor.applyFilter(doc.current, rec.filter)); toast(`Filtro: ${rec.label}`); }
          } else if (rec.action.brightness || rec.action.contrast || rec.action.saturation || rec.action.sharpness) {
            const doc = currentDoc();
            if (doc) { commit(Editor.applyAdjust(doc.current, rec.action)); toast('Ajuste aplicado'); }
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
    toast('Correção ideal aplicada pelo JARVIS 🎯');
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
    toast(`Ajustes aplicados em ${target.length} foto(s)`);
  }

  function exportAll() {
    const docs = selectedDocs().length > 0 ? selectedDocs() : state.docs;
    if (!docs.length) { toast('Nenhuma foto para exportar'); return; }
    const format = $('exportFormat').value;
    const sig = state.settings.signature;
    let count = 0, failed = 0;
    for (const doc of docs) {
      Editor.exportCanvas(doc.current, format, format === 'jpeg' ? 0.92 : 1, sig, sig.enabled, (blob) => {
        if (!blob) {
          failed++;
          toast(`Falha ao exportar ${doc.name}`);
        } else {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          download(blob, `${doc.name}-jarvis-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
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

  function exportCurrent() {
    const doc = currentDoc();
    if (!doc) { toast('Abra uma foto primeiro'); return; }
    const format = $('exportFormat').value;
    const sig = state.settings.signature;
    Editor.exportCanvas(doc.current, format, format === 'jpeg' ? 0.92 : 1, sig, sig.enabled, (blob) => {
      if (!blob) { toast('Falha ao exportar'); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(blob, `${doc.name}-jarvis-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
      toast('Exportado com assinatura ✓');
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
    $('btnClose').addEventListener('click', () => currentDoc() && closeDoc(currentDoc().id));
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);

    $('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
    $('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
    $('btnZoomFit').addEventListener('click', () => { state.zoomMode = 'fit'; state.zoom = computeFit(); render(); });
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
    render();
    renderCarousel();
    $('btnExport').disabled = true;
  }

  document.addEventListener('DOMContentLoaded', init);

  return { addFiles, analyzeCurrent, generateCaptions, exportCurrent, exportAll };
})();
