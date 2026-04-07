const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Start Express server
require('./server');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Floodgate',
    backgroundColor: '#080c10',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d1117',
      symbolColor: '#a78bfa',
      height: 52,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3847');

  // Open external links in the system browser, not in-app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Zoom: Ctrl/Cmd +/- to zoom, Ctrl/Cmd+0 to reset
  const ZOOM_STEP = 0.1;
  const ZOOM_MIN  = 0.5;
  const ZOOM_MAX  = 3.0;

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!input.control && !input.meta) return;

    const zoom = mainWindow.webContents.getZoomFactor();

    if (input.key === '+' || input.key === '=') {
      event.preventDefault();
      mainWindow.webContents.setZoomFactor(Math.min(zoom + ZOOM_STEP, ZOOM_MAX));
    } else if (input.key === '-') {
      event.preventDefault();
      mainWindow.webContents.setZoomFactor(Math.max(zoom - ZOOM_STEP, ZOOM_MIN));
    } else if (input.key === '0') {
      event.preventDefault();
      mainWindow.webContents.setZoomFactor(1.0);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Enforce single instance — focus existing window if already running
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    setTimeout(createWindow, 400);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});
