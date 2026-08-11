/* JARVIS Studio — Assistente de Mídia · versão Desktop (Electron)
 *
 * Carrega o mesmo SPA da web/versão móvel (file:// — zero servidor,
 * zero dependência de Python). Configurações:
 *   · contextIsolation ON + nodeIntegration OFF (segurança por padrão)
 *   · Downloads do app (blob <a download>) salvos automaticamente em Downloads
 *   · Flag --smoke: abre, valida o carregamento e sai (para testes/CI)
 *
 * Empacotamento: npm run dist → instalador Windows (electron-builder/NSIS).
 */
'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const isSmoke = process.argv.includes('--smoke');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: 'JARVIS Studio — Assistente de Mídia',
    backgroundColor: '#FCFCFC',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));

  // O app exporta via <a download> com blob URL — o Electron dispara
  // will-download; salvamos direto na pasta Downloads do usuário.
  win.webContents.session.on('will-download', (_e, item) => {
    const dl = app.getPath('downloads');
    item.setSavePath(path.join(dl, item.getFilename()));
  });

  if (isSmoke) {
    win.webContents.on('did-finish-load', () => {
      console.log('SMOKE OK — janela carregou');
      setTimeout(() => app.quit(), 400);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('SMOKE FAIL —', code, desc);
      app.exit(1);
    });
  }

  return win;
}

app.whenReady().then(() => {
  // evita cache entre execuções (garante a versão atual do disco)
  session.defaultSession.clearCache();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
