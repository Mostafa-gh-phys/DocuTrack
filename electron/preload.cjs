const {contextBridge} = require('electron');

contextBridge.exposeInMainWorld('docutrackDesktop', {
  isElectron: true,
  platform: process.platform,
});
