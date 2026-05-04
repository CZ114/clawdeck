const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companionDesktop", {
  close: () => ipcRenderer.invoke("window:close"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleCompact: () => ipcRenderer.invoke("window:toggle-compact"),
  setMode: (mode) => ipcRenderer.invoke("window:set-mode", mode),
  openSettings: () => ipcRenderer.invoke("open:settings"),
  openCards: () => ipcRenderer.invoke("open:cards"),
  openLive: () => ipcRenderer.invoke("open:live"),
  peekHover: () => ipcRenderer.invoke("window:peek-hover"),
  peekUnhover: () => ipcRenderer.invoke("window:peek-unhover"),
  doneAttention: () => ipcRenderer.invoke("window:done-attention"),
  ackAttention: () => ipcRenderer.invoke("window:ack-attention"),
  clearAttention: () => ipcRenderer.invoke("window:clear-attention"),
  setHold: (value) => ipcRenderer.invoke("window:set-hold", Boolean(value)),
  pickFolder: (options) => ipcRenderer.invoke("dialog:pick-folder", options || {}),
  openFolder: (folder) => ipcRenderer.invoke("shell:open-folder", folder),
  onCompactChanged: (callback) => {
    ipcRenderer.on("window:compact-changed", (_event, compact) => callback(Boolean(compact)));
  },
  onModeChanged: (callback) => {
    ipcRenderer.on("window:mode-changed", (_event, mode) => callback(String(mode || "compact")));
  },
  onPeekChanged: (callback) => {
    ipcRenderer.on("window:peek-changed", (_event, peeking) => callback(Boolean(peeking)));
  },
  onSnapChanged: (callback) => {
    ipcRenderer.on("window:snap-changed", (_event, edges) => callback(edges || {}));
  },
  onAttentionChanged: (callback) => {
    ipcRenderer.on("window:attention-changed", (_event, attention) => callback(attention || null));
  },
  onHoverExpandedChanged: (callback) => {
    ipcRenderer.on("window:hover-expanded-changed", (_event, expanded) => callback(Boolean(expanded)));
  },
  getEnabled: () => ipcRenderer.invoke("companion:get-enabled"),
  setEnabled: (enabled) => ipcRenderer.invoke("companion:set-enabled", enabled),
  onEnabledChanged: (callback) => {
    ipcRenderer.on("companion:enabled-changed", (_event, enabled) => callback(Boolean(enabled)));
  }
});
