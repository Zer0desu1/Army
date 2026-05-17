# 🖥️ Robot Köpek — Masaüstü Kontrol Uygulaması

> Electron + React + WebSocket tabanlı, ESP32 robot köpeği gerçek zamanlı kontrol eden masaüstü uygulaması.

---

## 🏗️ Mimari Genel Bakış

```
┌─────────────────────────────────────────────┐
│           Masaüstü Uygulama (Electron)       │
│                                             │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │  React UI    │◄──►│  WebSocket Client │  │
│  │  (Renderer)  │    │  (ws://robot-ip)  │  │
│  └──────────────┘    └────────┬──────────┘  │
│                               │             │
└───────────────────────────────┼─────────────┘
                                │ Wi-Fi (Port 81)
                    ┌───────────▼──────────┐
                    │   ESP32 Robot Köpek  │
                    │  (WebSocket Server)  │
                    └──────────────────────┘
```

---

## 📦 Proje Kurulumu

### Ön Gereksinimler

| Araç | Sürüm | İndirme |
|---|---|---|
| Node.js | 18.x veya üzeri | nodejs.org |
| npm | 9.x veya üzeri | Node.js ile gelir |
| Git | Herhangi | git-scm.com |

### Projeyi Oluşturma

```bash
# Yeni klasör oluştur
mkdir robot-kopek-app
cd robot-kopek-app

# package.json başlat
npm init -y

# Electron ve React bağımlılıkları
npm install electron electron-builder --save-dev
npm install react react-dom --save
npm install @vitejs/plugin-react vite --save-dev
npm install vite-plugin-electron --save-dev

# WebSocket istemci kütüphanesi (opsiyonel — tarayıcı WebSocket yerine)
npm install ws --save
```

### Dizin Yapısı

```
robot-kopek-app/
├── package.json
├── vite.config.js
├── electron/
│   ├── main.js              ← Electron ana süreç
│   └── preload.js           ← Güvenli köprü (contextBridge)
├── src/
│   ├── main.jsx             ← React giriş noktası
│   ├── App.jsx              ← Ana bileşen
│   ├── components/
│   │   ├── ConnectionPanel.jsx
│   │   ├── MovementPad.jsx
│   │   ├── EmotionPanel.jsx
│   │   ├── StatusBar.jsx
│   │   └── LogConsole.jsx
│   ├── hooks/
│   │   └── useDogWebSocket.js   ← WS bağlantı hook'u
│   ├── store/
│   │   └── robotStore.js        ← Zustand global state
│   └── styles/
│       └── globals.css
├── public/
│   └── icon.png
└── dist/                    ← Build çıktısı (otomatik oluşur)
```

---

## ⚙️ Yapılandırma Dosyaları

### `package.json`

```json
{
  "name": "robot-kopek-kontrol",
  "version": "1.0.0",
  "description": "ESP32 Robot Köpek Masaüstü Kontrol Paneli",
  "main": "electron/main.js",
  "scripts": {
    "dev": "vite",
    "electron:dev": "concurrently \"vite\" \"electron .\"",
    "build": "vite build && electron-builder",
    "preview": "vite preview"
  },
  "build": {
    "appId": "com.robokopek.control",
    "productName": "Robot Köpek",
    "directories": {
      "output": "dist-app"
    },
    "win": {
      "target": "nsis",
      "icon": "public/icon.png"
    },
    "mac": {
      "target": "dmg",
      "icon": "public/icon.png"
    },
    "linux": {
      "target": "AppImage",
      "icon": "public/icon.png"
    }
  },
  "devDependencies": {
    "concurrently": "^8.0.0",
    "electron": "^28.0.0",
    "electron-builder": "^24.0.0",
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.0.0"
  },
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "zustand": "^4.0.0"
  }
}
```

### `vite.config.js`

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
});
```

---

## 🔌 Electron Ana Süreç

### `electron/main.js`

```javascript
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Robot Köpek Kontrol',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // Platform'a göre ikon
    icon: path.join(__dirname, '../public/icon.png'),
  });

  // Geliştirme: Vite dev server | Production: build çıktısı
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC — Renderer'dan gelen mesajlar (opsiyonel)
ipcMain.handle('get-app-version', () => app.getVersion());
```

### `electron/preload.js`

```javascript
const { contextBridge, ipcRenderer } = require('electron');

// Renderer'a güvenli şekilde API aç
contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  platform: process.platform,
});
```

---

## 🔗 WebSocket Hook'u

### `src/hooks/useDogWebSocket.js`

```javascript
import { useRef, useState, useCallback, useEffect } from 'react';

const WS_PORT = 81;

export function useDogWebSocket(ip) {
  const wsRef    = useRef(null);
  const [connected, setConnected]   = useState(false);
  const [log, setLog]               = useState([]);
  const [robotState, setRobotState] = useState({
    emotion : 0,
    speed   : 50,
    sitting : false,
  });

  // Konsol logu
  const addLog = useCallback((msg, type = 'info') => {
    setLog(prev =>
      [{ msg, type, ts: new Date().toLocaleTimeString('tr-TR') }, ...prev].slice(0, 60)
    );
  }, []);

  // Bağlan
  const connect = useCallback(() => {
    if (!ip) return;
    if (wsRef.current) wsRef.current.close();

    const ws = new WebSocket(`ws://${ip}:${WS_PORT}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      addLog(`✓ ${ip}:${WS_PORT} bağlandı`, 'success');
    };
    ws.onclose = () => {
      setConnected(false);
      addLog('Bağlantı kesildi', 'warn');
    };
    ws.onerror = () => addLog('Bağlantı hatası', 'error');
    ws.onmessage = (e) => {
      try {
        const state = JSON.parse(e.data);
        setRobotState(state);
        addLog(`← durum alındı (hız: ${state.speed})`, 'recv');
      } catch {
        addLog(`← ham: ${e.data}`, 'recv');
      }
    };
  }, [ip, addLog]);

  // Bağlantıyı kes
  const disconnect = useCallback(() => {
    wsRef.current?.close();
  }, []);

  // Komut gönder
  const send = useCallback((cmd, value = null) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('Bağlı değil!', 'error');
      return false;
    }
    const payload = value !== null ? { cmd, value } : { cmd };
    wsRef.current.send(JSON.stringify(payload));
    addLog(`→ ${cmd}${value !== null ? ` [${value}]` : ''}`, 'send');
    return true;
  }, [addLog]);

  // Temizlik
  useEffect(() => () => wsRef.current?.close(), []);

  return { connected, connect, disconnect, send, log, robotState };
}
```

---

## 🗂️ Global State (Zustand)

### `src/store/robotStore.js`

```javascript
import { create } from 'zustand';

export const useRobotStore = create((set) => ({
  // Bağlantı
  ip        : '192.168.1.',
  connected : false,
  setIp     : (ip) => set({ ip }),
  setConnected: (connected) => set({ connected }),

  // Kontrol
  speed    : 50,
  steps    : 5,
  emotion  : 'neutral',
  sitting  : false,
  setSpeed : (speed)   => set({ speed }),
  setSteps : (steps)   => set({ steps }),
  setEmotion: (emotion) => set({ emotion }),
  setSitting: (sitting) => set({ sitting }),

  // Log
  logs   : [],
  addLog : (entry) =>
    set((s) => ({ logs: [entry, ...s.logs].slice(0, 100) })),
  clearLogs: () => set({ logs: [] }),
}));
```

---

## 🧩 Bileşenler

### `src/components/ConnectionPanel.jsx`

```jsx
import { useState } from 'react';
import { useRobotStore } from '../store/robotStore';

export function ConnectionPanel({ onConnect, onDisconnect, connected }) {
  const { ip, setIp } = useRobotStore();

  return (
    <div className="panel">
      <h3>Bağlantı</h3>
      <label>ESP32 IP Adresi</label>
      <input
        type="text"
        value={ip}
        onChange={(e) => setIp(e.target.value)}
        placeholder="192.168.1.x"
        disabled={connected}
      />
      {!connected ? (
        <button className="btn-primary" onClick={onConnect}>
          Bağlan
        </button>
      ) : (
        <button className="btn-danger" onClick={onDisconnect}>
          Bağlantıyı Kes
        </button>
      )}
      <div className={`status-dot ${connected ? 'online' : 'offline'}`}>
        {connected ? 'Bağlı' : 'Bağlı Değil'}
      </div>
    </div>
  );
}
```

### `src/components/MovementPad.jsx`

```jsx
import { useRef } from 'react';

const DIRECTIONS = [
  { cmd: null,    label: '',      row: 1, col: 1 },
  { cmd: 'walk',  label: 'İleri', row: 1, col: 2, icon: '↑' },
  { cmd: null,    label: '',      row: 1, col: 3 },
  { cmd: 'left',  label: 'Sol',   row: 2, col: 1, icon: '←' },
  { cmd: 'stop',  label: 'Dur',   row: 2, col: 2, icon: '■' },
  { cmd: 'right', label: 'Sağ',   row: 2, col: 3, icon: '→' },
  { cmd: null,    label: '',      row: 3, col: 1 },
  { cmd: 'back',  label: 'Geri',  row: 3, col: 2, icon: '↓' },
  { cmd: null,    label: '',      row: 3, col: 3 },
];

export function MovementPad({ send, steps }) {
  const holdRef = useRef(null);

  function startHold(cmd) {
    if (cmd === 'stop') { send('stop'); return; }
    send(cmd, steps);
    holdRef.current = setInterval(() => send(cmd, steps), 1000);
  }

  function stopHold() {
    clearInterval(holdRef.current);
  }

  return (
    <div className="dpad">
      {DIRECTIONS.map((dir, i) => {
        if (!dir.cmd) return <div key={i} />;
        return (
          <button
            key={i}
            className={`dpad-btn ${dir.cmd === 'stop' ? 'stop' : ''}`}
            onMouseDown={() => startHold(dir.cmd)}
            onMouseUp={stopHold}
            onMouseLeave={stopHold}
            onTouchStart={() => startHold(dir.cmd)}
            onTouchEnd={stopHold}
          >
            <span className="dpad-icon">{dir.icon}</span>
            <span className="dpad-label">{dir.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

### `src/components/EmotionPanel.jsx`

```jsx
const EMOTIONS = [
  { id: 'happy',   label: 'Mutlu',     emoji: '😄' },
  { id: 'excited', label: 'Heyecanlı', emoji: '⚡' },
  { id: 'sad',     label: 'Üzgün',     emoji: '😢' },
  { id: 'scared',  label: 'Korkmuş',   emoji: '😨' },
  { id: 'angry',   label: 'Sinirli',   emoji: '😠' },
  { id: 'sleepy',  label: 'Uykulu',    emoji: '😴' },
  { id: 'neutral', label: 'Normal',    emoji: '😐' },
];

export function EmotionPanel({ send, activeEmotion, setActiveEmotion }) {
  function handleEmotion(id) {
    setActiveEmotion(id);
    send('emotion', id);
  }

  return (
    <div className="emotion-grid">
      {EMOTIONS.map((e) => (
        <button
          key={e.id}
          className={`emotion-btn ${activeEmotion === e.id ? 'active' : ''}`}
          onClick={() => handleEmotion(e.id)}
        >
          <span className="emotion-emoji">{e.emoji}</span>
          <span className="emotion-label">{e.label}</span>
        </button>
      ))}
    </div>
  );
}
```

### `src/components/LogConsole.jsx`

```jsx
const TYPE_COLORS = {
  success : '#1D9E75',
  send    : '#7F77DD',
  recv    : '#378ADD',
  warn    : '#BA7517',
  error   : '#E24B4A',
  info    : '#555',
};

export function LogConsole({ logs, onClear }) {
  return (
    <div className="log-console">
      <div className="log-header">
        <span>Konsol</span>
        <button onClick={onClear} className="btn-ghost">Temizle</button>
      </div>
      <div className="log-body">
        {logs.map((entry, i) => (
          <div key={i} className="log-entry">
            <span className="log-ts">{entry.ts}</span>
            <span className="log-msg" style={{ color: TYPE_COLORS[entry.type] || '#999' }}>
              {entry.msg}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 🎨 Stil Dosyası

### `src/styles/globals.css`

```css
/* ─── Temel ─────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg-primary   : #0f0f0f;
  --bg-surface   : #141414;
  --bg-raised    : #1c1c1c;
  --border       : #2a2a2a;
  --text-primary : #f0f0f0;
  --text-muted   : #666;
  --accent       : #7F77DD;
  --success      : #1D9E75;
  --danger       : #E24B4A;
  --warn         : #BA7517;
  --radius-sm    : 8px;
  --radius-md    : 12px;
}

body {
  background   : var(--bg-primary);
  color        : var(--text-primary);
  font-family  : -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size    : 14px;
  user-select  : none;
}

/* ─── Panel ──────────────────────────────────────── */
.panel {
  background    : var(--bg-surface);
  border        : 0.5px solid var(--border);
  border-radius : var(--radius-md);
  padding       : 16px;
  display       : flex;
  flex-direction: column;
  gap           : 10px;
}

.panel h3 {
  font-size   : 11px;
  font-weight : 600;
  color       : var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ─── Input ──────────────────────────────────────── */
input[type="text"],
input[type="number"] {
  width         : 100%;
  background    : var(--bg-raised);
  border        : 0.5px solid var(--border);
  border-radius : var(--radius-sm);
  padding       : 8px 12px;
  color         : var(--text-primary);
  font-size     : 13px;
  outline       : none;
  transition    : border-color 0.15s;
}

input[type="text"]:focus { border-color: var(--accent); }

input[type="range"] {
  width        : 100%;
  accent-color : var(--accent);
  cursor       : pointer;
}

/* ─── Butonlar ───────────────────────────────────── */
button { cursor: pointer; font-family: inherit; }

.btn-primary {
  background    : var(--accent);
  border        : none;
  border-radius : var(--radius-sm);
  color         : #fff;
  padding       : 9px 16px;
  font-size     : 13px;
  font-weight   : 500;
  transition    : opacity 0.15s;
}
.btn-primary:hover { opacity: 0.85; }

.btn-danger {
  background    : transparent;
  border        : 0.5px solid var(--danger);
  border-radius : var(--radius-sm);
  color         : var(--danger);
  padding       : 9px 16px;
  font-size     : 13px;
}

.btn-ghost {
  background    : transparent;
  border        : none;
  color         : var(--text-muted);
  font-size     : 11px;
  padding       : 4px 8px;
}
.btn-ghost:hover { color: var(--text-primary); }

/* ─── D-Pad ──────────────────────────────────────── */
.dpad {
  display               : grid;
  grid-template-columns : repeat(3, 72px);
  grid-template-rows    : repeat(3, 72px);
  gap                   : 8px;
  justify-content       : center;
}

.dpad-btn {
  background    : var(--bg-raised);
  border        : 0.5px solid var(--border);
  border-radius : var(--radius-md);
  display       : flex;
  flex-direction: column;
  align-items   : center;
  justify-content: center;
  gap           : 4px;
  transition    : background 0.1s, border-color 0.1s;
}

.dpad-btn:active,
.dpad-btn.holding {
  background    : #7F77DD22;
  border-color  : var(--accent);
}

.dpad-btn.stop { border-color: #E24B4A44; color: var(--danger); }
.dpad-btn.stop:active { background: #E24B4A15; }

.dpad-icon  { font-size: 20px; }
.dpad-label { font-size: 10px; color: var(--text-muted); }

/* ─── Duygu Grid ─────────────────────────────────── */
.emotion-grid {
  display               : grid;
  grid-template-columns : repeat(4, 1fr);
  gap                   : 8px;
}

.emotion-btn {
  background    : var(--bg-raised);
  border        : 0.5px solid var(--border);
  border-radius : var(--radius-md);
  padding       : 12px 6px;
  display       : flex;
  flex-direction: column;
  align-items   : center;
  gap           : 6px;
  transition    : all 0.15s;
}
.emotion-btn:hover    { background: #252525; }
.emotion-btn.active   { border-color: var(--accent); background: #7F77DD18; }

.emotion-emoji { font-size: 22px; }
.emotion-label { font-size: 11px; color: var(--text-muted); }
.emotion-btn.active .emotion-label { color: var(--accent); }

/* ─── Log Konsol ─────────────────────────────────── */
.log-console {
  background    : var(--bg-raised);
  border        : 0.5px solid var(--border);
  border-radius : var(--radius-md);
  display       : flex;
  flex-direction: column;
  height        : 260px;
}

.log-header {
  padding        : 10px 14px;
  border-bottom  : 0.5px solid var(--border);
  display        : flex;
  justify-content: space-between;
  align-items    : center;
  font-size      : 11px;
  font-weight    : 600;
  color          : var(--text-muted);
  text-transform : uppercase;
  letter-spacing : 1px;
}

.log-body {
  flex       : 1;
  overflow-y : auto;
  padding    : 8px;
  font-family: monospace;
  font-size  : 11px;
}

.log-entry {
  display    : flex;
  gap        : 10px;
  padding    : 2px 4px;
  border-radius: 4px;
}
.log-entry:hover { background: #222; }

.log-ts  { color: #444; white-space: nowrap; }
.log-msg { word-break: break-all; }

/* ─── Status dot ─────────────────────────────────── */
.status-dot {
  display    : flex;
  align-items: center;
  gap        : 8px;
  font-size  : 13px;
}
.status-dot::before {
  content      : '';
  width        : 8px;
  height       : 8px;
  border-radius: 50%;
}
.status-dot.online  { color: var(--success); }
.status-dot.online::before  { background: var(--success); box-shadow: 0 0 6px var(--success); }
.status-dot.offline { color: var(--danger); }
.status-dot.offline::before { background: var(--danger); }
```

---

## 📡 Komut Protokolü Referansı

### Gönderilen Komutlar (Uygulama → ESP32)

```javascript
// Hareket
ws.send(JSON.stringify({ cmd: 'walk',  value: 10   }));  // ileri
ws.send(JSON.stringify({ cmd: 'back',  value: 5    }));  // geri
ws.send(JSON.stringify({ cmd: 'left',  value: 3    }));  // sola dön
ws.send(JSON.stringify({ cmd: 'right', value: 3    }));  // sağa dön
ws.send(JSON.stringify({ cmd: 'stop'               }));  // dur

// Poz
ws.send(JSON.stringify({ cmd: 'sit'                }));  // otur
ws.send(JSON.stringify({ cmd: 'stand'              }));  // ayağa kalk
ws.send(JSON.stringify({ cmd: 'greet'              }));  // selamla

// Ayar
ws.send(JSON.stringify({ cmd: 'speed', value: 75   }));  // hız (0–100)

// Duygu
ws.send(JSON.stringify({ cmd: 'emotion', value: 'happy'   }));
ws.send(JSON.stringify({ cmd: 'emotion', value: 'sad'     }));
ws.send(JSON.stringify({ cmd: 'emotion', value: 'excited' }));
ws.send(JSON.stringify({ cmd: 'emotion', value: 'scared'  }));
ws.send(JSON.stringify({ cmd: 'emotion', value: 'angry'   }));
ws.send(JSON.stringify({ cmd: 'emotion', value: 'sleepy'  }));
ws.send(JSON.stringify({ cmd: 'emotion', value: 'neutral' }));
```

### Alınan Durum (ESP32 → Uygulama)

```javascript
// ws.onmessage içinde
ws.onmessage = (event) => {
  const state = JSON.parse(event.data);
  // state.emotion  → number (0=NEUTRAL, 1=HAPPY, ...)
  // state.speed    → number (0–100)
  // state.sitting  → boolean
};
```

---

## 🚀 Geliştirme & Build

### Geliştirme Modunda Çalıştırma

```bash
# Terminal 1 — Vite dev server
npm run dev

# Terminal 2 — Electron (Vite'ı bekleyin)
npx electron .
```

Veya tek komutla (concurrently kuruluysa):

```bash
npm run electron:dev
```

### Production Build

```bash
# Tüm platformlar için build
npm run build

# Yalnızca Windows
npx electron-builder --win

# Yalnızca macOS
npx electron-builder --mac

# Yalnızca Linux
npx electron-builder --linux
```

Build çıktısı `dist-app/` klasöründe oluşur:

| Platform | Çıktı Dosyası |
|---|---|
| Windows | `Robot Kopek Setup 1.0.0.exe` |
| macOS | `Robot Kopek-1.0.0.dmg` |
| Linux | `Robot Kopek-1.0.0.AppImage` |

---

## 🔧 Sorun Giderme

| Belirti | Neden | Çözüm |
|---|---|---|
| WebSocket bağlanamıyor | Yanlış IP | ESP32 Serial Monitor'dan IP'yi kontrol et |
| WebSocket bağlanamıyor | Güvenlik duvarı | Windows Defender / macOS Firewall port 81'e izin ver |
| Electron pencere açılmıyor | Port 5173 dolu | `vite --port 5174` ile değiştir |
| Build başarısız | Node.js sürümü eski | Node.js 18+ kullan |
| `ws is not defined` hatası | Tarayıcı API farkı | `new WebSocket(...)` kullan, `ws` npm paketi değil |
| Komut gönderilmiyor | Bağlantı yok | `connected` state'ini ve WS `readyState`'ini kontrol et |

---

## 🌐 Alternatif: Web Arayüzü (Electron Olmadan)

ESP32 üzerinde bir HTTP sunucusu çalıştırarak tarayıcı tabanlı kontrol de mümkündür. Bu durumda Electron'a gerek kalmaz.

```cpp
// ESP32'ye eklenecek ek kod (Arduino)
#include <WebServer.h>
WebServer httpServer(80);

void setup() {
  // ... mevcut setup kodunuz ...
  httpServer.on("/", HTTP_GET, []() {
    httpServer.send(200, "text/html", "<h1>Robot Kopek</h1>");
  });
  httpServer.begin();
}

void loop() {
  httpServer.handleClient();
  webSocket.loop();
  // ...
}
```

Tarayıcıdan `http://192.168.1.XX` adresine giderek erişilebilir. WebSocket bağlantısı aynı kalır.

---

## 📋 Geliştirme Yol Haritası

- [x] WebSocket bağlantı yönetimi
- [x] Yön kontrolü (D-Pad)
- [x] Duygu paneli
- [x] Hız ve adım ayarı
- [x] Konsol logu
- [ ] Gamepad / joystick desteği (`Gamepad API`)
- [ ] Robot kamera görüntüsü (ESP32-CAM entegrasyonu)
- [ ] Makro kayıt & oynatma (hareket dizileri)
- [ ] Bağlantı otomatik yeniden deneme
- [ ] Ayarlar ekranı (IP kaydet, tema seç)
- [ ] Türkçe / İngilizce dil desteği

---

*Hazırlanma tarihi: 2025 · Electron 28 · React 18 · WebSocket (Port 81)*