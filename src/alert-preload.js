const { contextBridge, ipcRenderer } = require('electron');

// What the alert's page may ask of the app, and be told by it.
contextBridge.exposeInMainWorld('alertApi', {
  onSay: (cb) => { ipcRenderer.on('say', (_e, message) => cb(message)); },
  onPlace: (cb) => { ipcRenderer.on('place', (_e, where) => cb(where)); },
  size: (height) => ipcRenderer.send('alert-size', height),
  done: (clicked) => ipcRenderer.send('alert-done', clicked),
});
