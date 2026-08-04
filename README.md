# JARVIS Studio — Assistente de Mídia

Versão **web** do assistente de mídia do JARVIS: edição de fotos com IA local,
geração de legendas PT-BR, sugestões proativas, assinatura/watermark —
**100% offline, sem CDN**.

> Projeto-irmão do editor desktop (`~/fotoeditor/`, Python/Tkinter). Este nasceu
> do pedido: "quero que o próprio JARVIS analise o padrão da foto e me ajude
> a deixá-la ideal, além de sugerir legendas e assinar minhas fotos" — e que
> funcionasse **no navegador**.

## Rodar

```powershell
python server.py        # ou: run.bat
# abra http://localhost:3336
```

O servidor é `http.server` puro do Python — **zero dependências**. Para parar: `Ctrl+C`.

## O que faz

| Aba | Função |
|---|---|
| **Ajustes** | Brilho, contraste, saturação, nitidez, temperatura (preview ao vivo) · **✂️ Cortar** (seleção arrastável, proporções Livre/1:1/4:5/16:9/3:2) |
| **Filtros** | 27 filtros (Correção ideal, Vívido, P&B, sépia, duotone, cartoon, neon, HDR, lomo, vintage…) |
| **Mesclagem** | 15 modos de blend com "preparo" (blur+screen = glow, etc.) |
| **Assistente** | IA local JARVIS: diagnóstico técnico + nota 0–100 + **opinião** + **recomendações proativas** + correção ideal profissional + legendas |
| **Assinatura** | Watermark configurável (texto, fonte, posição, opacidade, sombra) + IA externa opcional |

### Zoom e corte

- **🔍 − / 🔍 +** aplicam zoom real na foto (o canvas cresce/diminui; antes o CSS
  `max-width:100%` travava o crescimento). **⤢** reajusta à tela. O percentual
  atual aparece no badge ao lado; com zoom acima do encaixe, o stage vira scroll.
- **✂️ Cortar** (aba Ajustes) ativa o modo de corte estilo Photoshop: arraste na
  área escura para criar a seleção, arraste dentro para mover, use os 4 cantos
  para redimensionar e escolha proporções prontas (Livre, 1:1, 4:5, 16:9, 3:2).
  "Aplicar corte" grava no histórico (desfazer/refazer funcionam).

### Identidade visual (LOGO MIDIA)

A interface usa a logo oficial `assets/logo.png` (selo circular navy `#1B2637`
sobre branco `#FCFCFC`): header navy com o emblema, favicon, empty state e
paleta completa derivada do emblema (navy `#1B2637`, navy médio `#1C2D48`,
azul aço `#2D4A6E`, branco `#FCFCFC`, cinza azulado `#555E6B`).

### Correção ideal profissional (estilo Photoshop)

A correção automática **não usa multiplicação cega** (o `brightness/contrast/
saturate` do CSS estoura claros e esmaga sombras — o resultado "estranho").
O pipeline replica os algoritmos do Photoshop:

1. **Auto Color** — gray world: neutraliza o cast de cor nos midtones,
   com máscara de luminosidade (plena no médio, reduzida nos extremos).
2. **Auto Tone** — black point / white point via **percentis** (p1/p99, estáveis
   a ruído) + gamma para levar o midtone ao alvo. Força parcial (65%):
   o Photoshop não aplica 100% do Auto — deixa espaço para o olho.
3. **Curves** — S-curve suave de contraste perceptivo (transição em "ladeira").
4. **Saturação** — leve, só quando fora da faixa saudável (0.32–0.72).
5. **Nitidez seletiva** — máscara de luminosidade (protege sombras/claros → sem halos).

Análise também ganhou **percentis** (p1/p50/p99) e diagnóstico de faixa tonal
("Sem pretos reais — as sombras começam em X", "Sem brancos reais…").

### IA local (Analyzer)

Heurística determinística em ImageData: exposição, contraste, saturação,
nitidez (sobel simplificado), temperatura de cor, nível de ruído,
composição (quadrantes), clima, **faixa tonal por percentis**. Gera:

- **Opinião do JARVIS** — texto conversacional sobre a foto
- **Diagnóstico** legível por item (✅/⚠️/🔴)
- **Nota 0–100** da foto
- **Correção ideal** (`Editor.autoEnhance`) — o botão "🎯 Aplicar correção ideal"
- **Recomendações proativas assertivas** — apontam o problema real (ex.: "Nitidez
  seletiva — sem halos"), nunca "HDR para tudo"
- **Atributos semânticos** (mood/tone/period) para legendas

### Legendas

- **Local (offline)**: templates PT-BR em 7 estilos (curto, engajador, poético, diário, story, reel, profissional)
  combinados com o retrato da foto + local/contexto opcional + hashtags.
- **Com IA (opcional)**: se houver chave OpenAI (aba Assinatura → API), gera legenda única.
  ⚠️ A chave fica no `localStorage` do navegador — uso pessoal/local apenas.

### Assinatura

Watermark aplicado na exportação (e no preview). Padrão salvo no navegador.

### Operações em lote

- **Ctrl+click** no carrossel para selecionar múltiplas fotos
- **"🎯 Corrigir todas"** na toolbar aplica a correção ideal em todas as selecionadas
- **Exportar tudo** exporta todas as fotos selecionadas (ou todas, se nenhuma selecionada)

## Arquitetura (PORQUÊ)

```
media-assistant/
├── server.py          # http.server puro (porta 3336) — zero deps (local)
├── vercel.json        # deploy estático (Vercel) — sem backend
├── run.bat            # atalho Windows
├── index.html         # SPA: toolbar + stage + painel de abas + carrossel
├── assets/logo.png    # LOGO MIDIA oficial (selo navy) — favicon/branding
├── css/style.css      # tema claro navy derivado da logo
├── js/
│   ├── storage.js     # wrapper localStorage (prefixo jarvis_media_)
│   ├── analyzer.js    # IA local: analyze / diagnose / recommend / opinion / suggestAdjustments
│   ├── captions.js    # gerador de legendas PT-BR (7 estilos, puro, testável no Node)
│   ├── ai.js          # OpenAI opcional (client-side)
│   ├── editor.js      # motor Canvas 2D (filtros, blend, crop, watermark, export) — funções PURAS
│   └── app.js          # orquestrador: estado, histórico, carrossel, zoom, crop, eventos, batch
└── tests/             # node:test (sem DOM)
    ├── analyzer.test.js   # 12 testes — métricas, diagnóstico, recomendações, opinião
    ├── captions.test.js   # 8 testes — geração de legendas, estilos, contexto
    └── editor.test.js     # 25 testes — puras do editor + motor profissional + crop + Analyzer
```

- **Vanilla JS + IIFE modules, sem framework e sem build** → funciona abrindo o
  arquivo ou servido de qualquer lugar; offline de verdade, sem CDN (lição do
  projeto finanças, que usava Chart.js/Font Awesome via CDN e degradava sem rede).
- **Separação de camadas** igual ao finanças: `Storage` (persistência) ·
  `Editor` (motor puro, recebe canvas → devolve canvas novo) · `App` (UI/estado).
  O `Editor` nunca toca no DOM global — só o `App` faz isso.
- **Motor profissional puro e testável no Node**: `percentile`, `buildToneLUT`,
  `applyLutLuminosity`, `grayWorldCast`, `applyCast`, `sCurveLUT`,
  `sharpenLuminosity`, `histOf` — não usam DOM, rodam direto no `node --test`.
- **IA em duas camadas**: local determinística (base, sem custo, sem envio de
  dados) + externa opcional (extra criativo). Zero trust: chave nunca sai do navegador.
- **Recomendações proativas**: o JARVIS não só corrige, mas sugere o quê fazer
  e por quê — filtro recomendado, ajuste sugerido, dica de composição.

## Testes

```powershell
node --test tests/analyzer.test.js tests/captions.test.js tests/editor.test.js
```

43 testes: métricas de análise (exposição, dominância quente/fria, nitidez,
ruído, composição, **faixa tonal por percentis**), diagnóstico/nota/correção
ideal/recomendações/opinião, geração de legendas com 7 estilos, funções puras
do editor (pixelMap, convolve), **motor profissional** (percentile, tone LUT,
gray world cast, S-curve, máscaras de luminosidade) e **recorte** (`cropData`).

## Deploy (Vercel)

O projeto é 100% estático (o `server.py` serve só para desenvolvimento local).
No Vercel:

```powershell
vercel --prod
```

O `vercel.json` já configura `cleanUrls` e cache de longo prazo para `assets/`.
Após o deploy, a URL fica no formato `https://<projeto>.vercel.app`.

## Riscos / próximos passos

- `editor.js` usa Canvas — testes de filtros exigiriam ambiente com canvas
  (ex.: `node-canvas` ou validação visual manual). O motor profissional é puro
  e coberto por testes.
- IA externa (OpenAI) depende de rede; o fallback local cobre o caso offline.
- Possível evolução: exportar vídeo/GIF, suporte WebP, PWA, auto-crop
  inteligente, seleção de melhor frame em lote, histograma visual, modo
  comparar antes/depois, presets de correção (retrato/paisagem).
