const {app, BrowserWindow, shell} = require('electron');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

let mainWindow = null;
let serverInstance = null;

function startDesktopServer() {
  return new Promise((resolve, reject) => {
    const serverApp = express();
    serverApp.use(express.json({limit: '4mb'}));

    const distDir = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(distDir)) {
      serverApp.use(express.static(distDir));
      serverApp.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    } else {
      serverApp.get('/{*splat}', (_req, res) => {
        res.status(200).send('DocuTrack desktop build missing dist/ bundle. Run npm run build first.');
      });
    }

    const server = http.createServer(serverApp);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverInstance = server;
      resolve(addr.port);
    });
  });
}

async function createWindow() {
  const port = await startDesktopServer();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 920,
    minHeight: 620,
    title: 'DocuTrack',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return {action: 'deny'};
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  void createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
