/**
 * Dict Sync - Background Service Worker
 * 仅服务 popup 查询/清除数据，存储直接由 content script 操作
 */
var STORAGE_KEY = 'dict_sync_data';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === 'GET_DATA') {
    chrome.storage.local.get(STORAGE_KEY).then(function (result) {
      var data = result[STORAGE_KEY] || { dictTypes: [], dictValues: [], lastUpdated: 0 };
      var types = 0, values = 0;
      (data.dictTypes || []).forEach(function (g) { types += (g.list ? g.list.length : 0); });
      (data.dictValues || []).forEach(function (g) { values += (g.values ? g.values.length : 0); });
      sendResponse({ success: true, data: data, count: { types: types, values: values, total: types + values } });
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