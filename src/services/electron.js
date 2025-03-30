const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

const createWindow = () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  console.log(`[INFO] Screen dimensions: ${width}x${height}`);

  const win = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    webPreferences: { 
      nodeIntegration: true, 
      contextIsolation: false,
      webSecurity: false
    },
    show: false,
  });

  win.once('ready-to-show', () => {
    win.show();
    win.maximize();
    console.log('[INFO] Electron window maximized');
  });

  win.loadFile(path.join(__dirname, '../../index.html'));
  return win;
};

const setupElectron = () => {
  let mainWindow = null;
  
  if (app.isReady()) {
    mainWindow = createWindow();
  } else {
    app.whenReady().then(() => {
      mainWindow = createWindow();
      
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createWindow();
        }
      });
    });
  }

  app.on('window-all-closed', () => app.quit());
  
  return mainWindow;
};

module.exports = { setupElectron };
