// Bridge between the sandboxed UI and the main process.
// Only these capabilities are exposed — nothing else from Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getConfig:  ()        => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg)     => ipcRenderer.invoke('config:save', cfg),
  relaunch:   ()        => ipcRenderer.invoke('app:relaunch'),
  diag:       ()        => ipcRenderer.invoke('sys:diag'),
  getStats:   ()        => ipcRenderer.invoke('stats:get'),
  launch:     (target)  => ipcRenderer.invoke('apps:launch', target),
  askClaude:  (prompt)  => ipcRenderer.invoke('claude:ask', prompt),
  onClaudeDelta:(cb)    => ipcRenderer.on('claude:delta', (_e, chunk) => cb(chunk)),
  resetClaude:()        => ipcRenderer.invoke('claude:reset'),
  voiceSpeak: (text)    => ipcRenderer.invoke('voice:speak', text),
  voiceTest:  (piper, text) => ipcRenderer.invoke('voice:test', { piper, text }),
  onVoicePlay:(cb)      => ipcRenderer.on('voice:play', (_e, payload) => cb(payload)),
  quit:       ()        => ipcRenderer.invoke('app:quit'),

  // Spotify — now playing, playlists, and transport controls.
  spotifyState:     ()       => ipcRenderer.invoke('spotify:state'),
  spotifyLogin:     ()       => ipcRenderer.invoke('spotify:login'),
  spotifyLogout:    ()       => ipcRenderer.invoke('spotify:logout'),
  spotifyPlaylists: ()       => ipcRenderer.invoke('spotify:playlists'),
  spotifyControl:   (action) => ipcRenderer.invoke('spotify:control', action),
  spotifyPlay:      (uri)    => ipcRenderer.invoke('spotify:play', uri)
});
