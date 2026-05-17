const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const os = require('os');

const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_IS_DEV === '1';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Robot Köpek Kontrol',
    backgroundColor: '#080b14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:4200');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/desktop-app/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('scan-network', async () => {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
      const address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }

  const activeIPs = [];
  const promises = [];

  for (const localIp of addresses) {
    const parts = localIp.split('.');
    parts.pop();
    const baseIp = parts.join('.') + '.';

    for (let i = 1; i <= 254; i++) {
      const targetIp = baseIp + i;
      promises.push(new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(250); // 250ms timeout for scanning
        
        socket.on('connect', () => {
          activeIPs.push(targetIp);
          socket.destroy();
          resolve();
        });
        
        const finish = () => { socket.destroy(); resolve(); };
        socket.on('timeout', finish);
        socket.on('error', finish);
        
        socket.connect(81, targetIp);
      }));
    }
  }

  await Promise.all(promises);
  return activeIPs;
});
