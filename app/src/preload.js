'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const calls = ['status','start','stop','kill','reset-disk','import','download','save-settings','pick-share','open-share','apps','launch','install-pkg','search-pkg','ai-task','ai-open','terminal','screenshot','open-log'];
const api = {};
for (const c of calls) api[c.replace(/-(\w)/g, (m, x) => x.toUpperCase())] = (...a) => ipcRenderer.invoke(c, ...a);
api.on = (ch, fn) => ipcRenderer.on(ch, (e, ...a) => fn(...a));
contextBridge.exposeInMainWorld('ppt', api);
