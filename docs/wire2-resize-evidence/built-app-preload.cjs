const { contextBridge, ipcRenderer } = require('electron');
const noop = () => {};
contextBridge.exposeInMainWorld('api', {
  platform: { isLinux: false, isMacOS: false },
  listen: { getState: () => ipcRenderer.invoke('diagnosis:state'), onState: callback => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('diagnosis:state', handler);
    return () => ipcRenderer.removeListener('diagnosis:state', handler);
  } },
  listenView: { adjustWindowHeight: (name, height) => ipcRenderer.invoke('diagnosis:height', { name, height }) },
  sttView: { onSttUpdate: noop, removeOnSttUpdate: noop },
  summaryView: { onSummaryUpdate: noop, removeAllSummaryUpdateListeners: noop },
  pickleGlassApp: { onClickThroughToggled: noop, removeAllClickThroughListeners: noop },
  listenCapture: { onSystemAudioData: noop },
  renderer: { onChangeListenCaptureState: noop }
});
