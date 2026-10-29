/**
 * Auth Resource Sync - Background Service Worker
 */
var STORAGE_KEY = 'auth_resource_sync_data';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === 'GET_DATA') {
    chrome.storage.local.get(STORAGE_KEY).then(function (result) {
      var data = result[STORAGE_KEY] || { devTree: [], testTree: [], syncTasks: [], lastUpdated: 0 };
      sendResponse({ success: true, data: data });
    });
    return true;
  }

  if (msg.type === 'CLEAR_DATA') {
    chrome.storage.local.remove(STORAGE_KEY).then(function () {
      sendResponse({ success: true });
    });
    return true;
  }

  sendResponse({ success: false, error: 'Unknown message' });
  return false;
});