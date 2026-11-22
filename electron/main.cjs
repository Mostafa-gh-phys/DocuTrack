const {app, BrowserWindow, Menu, shell} = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

// Restrict renderer JS heap and background CPU usage without impairing document decoding
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
app.commandLine.appendSwitch('renderer-process-limit', '2');

let mainWindow = null;
let serverInstance = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function startDesktopServer() {
  return new Promise((resolve, reject) => {
    const distDir = path.join(__dirname, '..', 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        let relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
        if (!relPath) relPath = 'index.html';

        const candidate = path.normalize(path.join(distDir, relPath));
        const insideDist = candidate.startsWith(distDir);

        let targetFile = insideDist && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : indexHtmlPath;

        if (!fs.existsSync(targetFile)) {
          res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
          res.end('DocuTrack desktop build missing dist/ bundle. Run npm run build first.');
          return;
        }

        const ext = path.extname(targetFile).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const data = fs.readFileSync(targetFile);
        res.writeHead(200, {'Content-Type': contentType});
        res.end(data);
      } catch (err) {
        res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end(err instanceof Error ? err.message : 'Internal Server Error');
      }
    });

    const PREFERRED_PORT = 34819;
    let triedFallback = false;

    server.on('error', (err) => {
      if (!triedFallback && err && err.code === 'EADDRINUSE') {
        triedFallback = true;
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(err);
    });

    server.once('listening', () => {
      const addr = server.address();
      serverInstance = server;
      resolve(addr.port);
    });

    server.listen(PREFERRED_PORT, '127.0.0.1');
  });
}

async function createWindow() {
  const port = await startDesktopServer();
  const iconCandidates = [
    path.join(__dirname, '..', 'dist', 'pwa-512x512.png'),
    path.join(__dirname, '..', 'public', 'pwa-512x512.png'),
  ];
  const resolvedIcon = iconCandidates.find((p) => fs.existsSync(p));

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 920,
    minHeight: 620,
    title: 'DocuTrack',
    autoHideMenuBar: true,
    ...(resolvedIcon ? {icon: resolvedIcon} : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });

  if (typeof mainWindow.removeMenu === 'function') {
    mainWindow.removeMenu();
  }
  mainWindow.setMenuBarVisibility(false);

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
  Menu.setApplicationMenu(null);
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
