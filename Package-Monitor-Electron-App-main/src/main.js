const { app, BrowserWindow, ipcMain, dialog,nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const dataFilePath = path.join(app.getPath('userData'), 'projects.json');

let mainWindow;


// Replace ipcMain.handleOnce with ipcMain.handle
ipcMain.handle('open-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });

  if (result.canceled) {
    return null;
  }

  const projectPath = result.filePaths[0];
  const projectName = path.basename(projectPath);

  return { projectName, projectPath };
});
ipcMain.handle('save-projects', (event, projects) => {
  fs.writeFileSync(dataFilePath, JSON.stringify(projects, null, 2));
});

ipcMain.handle('load-projects', () => {
  if (fs.existsSync(dataFilePath)) {
    const data = fs.readFileSync(dataFilePath, 'utf-8');
    return JSON.parse(data);
  }
  return [];
});

ipcMain.handle('show-message', (event, message) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['OK'],
    title: 'Information',
    message: message,
  });
});

function createWindow() {

  const iconPath = getIconPath();
  console.log('Icon path:', iconPath);

  const icon = nativeImage.createFromPath(iconPath);
  
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: icon,
    webPreferences: {
      preload: path.join(__dirname,  'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  console.log('Icon path:', getIconPath());  // Add this line for debugging

  mainWindow.loadFile('src/index.html');
}

app.on('ready', createWindow);

app.on('ready', () => {
  if (mainWindow) {
    mainWindow.webContents.session.clearCache(() => {
      console.log('Cache cleared');
    });
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('notification-clicked', (event, projectName, type) => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('open-project-from-notification', projectName, type);
  } else {
    createWindow();
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('open-project-from-notification', projectName, type);
    });
  }
});

function getIconPath() {
  switch (process.platform) {
    case 'darwin':
      return path.join(__dirname, '..', 'build', 'icons', '512x512.png');
    case 'win32':
      return path.join(__dirname, '..', 'build', 'icons', 'icon.ico');
    default:
      return path.join(__dirname, '..', 'build', 'icons', '512x512.png');
  }
}
console.log('Icon path:', getIconPath());  // Add this line outside the function
ipcMain.handle('get-icon-path', () => {
  const iconPath = getIconPath();
  return path.resolve(iconPath);
});


app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(getIconPath());
  }
  createWindow();
});
