// Bridge between the sandboxed UI and the main process.
// Only these capabilities are exposed — nothing else from Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getConfig:  ()        => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg)     => ipcRenderer.invoke('config:save', cfg),
  relaunch:   ()        => ipcRenderer.invoke('app:relaunch'),
  getStats:   ()        => ipcRenderer.invoke('stats:get'),
  launch:     (target)  => ipcRenderer.invoke('apps:launch', target),
  askClaude:  (prompt)  => ipcRenderer.invoke('claude:ask', prompt),
  resetClaude:()        => ipcRenderer.invoke('claude:reset'),
  checkEmail: ()        => ipcRenderer.invoke('email:check'),
  voiceSpeak: (text)    => ipcRenderer.invoke('voice:speak', text),
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
