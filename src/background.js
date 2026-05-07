// MV3 service worker. Currently a stub — will own the native messaging
// connection to the local git host process.

chrome.runtime.onInstalled.addListener(() => {
    console.log('[pybricks-git] installed');
});

// Placeholder for future native messaging:
//   const port = chrome.runtime.connectNative('com.pybricks.git');
//   port.onMessage.addListener(...);
//   port.postMessage({ op: 'commit', ... });
