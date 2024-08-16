const { contextBridge, ipcRenderer } = require('electron');


contextBridge.exposeInMainWorld('electron', {
  openProject: () => ipcRenderer.invoke('open-project'),
  getProjects: () => ipcRenderer.invoke('get-projects'),
  deleteProject: (projectName) => ipcRenderer.invoke('delete-project', projectName),
  
  GITHUB_TOKEN: process.env.GITHUB_TOKEN

});
