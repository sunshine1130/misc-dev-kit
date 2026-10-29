/**
 * Auth Resource Sync - Popup Script
 */
(function () {
  'use strict';
  var STORAGE_KEY = 'auth_resource_sync_data';

  var noDataEl = document.getElementById('no-data');
  var hasDataEl = document.getElementById('has-data');
  var srcCountEl = document.getElementById('popup-dev-count');
  var tgtCountEl = document.getElementById('popup-test-count');
  var queueCountEl = document.getElementById('popup-queue-count');
  var currentUrlEl = document.getElementById('current-url');
  var btnExport = document.getElementById('btn-export');
  var btnClear = document.getElementById('btn-clear');

  async function init() {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0] && tabs[0].url) currentUrlEl.textContent = tabs[0].url;
    } catch (e) { currentUrlEl.textContent = '-'; }

    var data = await loadData();
    renderData(data);

    btnExport.addEventListener('click', function () { exportData(data); });
    btnClear.addEventListener('click', function () { clearData(); });
  }

  async function loadData() {
    try {
      var result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || { sourceTree: [], targetTree: [], syncTasks: [], lastUpdated: 0 };
    } catch (e) { return { sourceTree: [], targetTree: [], syncTasks: [], lastUpdated: 0 }; }
  }

  function countNodes(nodes) {
    if (!nodes) return 0;
    var c = 0;
    nodes.forEach(function (n) {
      c++;
      if (n.children) c += countNodes(n.children);
      if (n.resourceDetailList) c += n.resourceDetailList.length;
    });
    return c;
  }

  function renderData(data) {
    var srcCount = countNodes(data.devTree || data.sourceTree || []);
    var tgtCount = countNodes(data.testTree || data.targetTree || []);
    var queueCount = (data.syncTasks || []).length + (data.singleTasks || []).length;

    if (srcCount === 0 && tgtCount === 0 && queueCount === 0) {
      noDataEl.style.display = '';
      hasDataEl.style.display = 'none';
      return;
    }
    noDataEl.style.display = 'none';
    hasDataEl.style.display = '';

    if (srcCountEl) srcCountEl.textContent = srcCount + ' \u8282\u70B9';
    if (tgtCountEl) tgtCountEl.textContent = tgtCount + ' \u8282\u70B9';
    if (queueCountEl) queueCountEl.textContent = queueCount + ' \u6761';
  }

  function exportData(data) {
    var clean = {
      sourceAppId: data.devAppId || data.sourceAppId,
      targetAppId: data.testAppId || data.targetAppId,
      sourceTree: data.devTree || data.sourceTree || [],
      targetTree: data.testTree || data.targetTree || [],
      syncTasks: (data.syncTasks || []).map(function (t) {
        return {
          sourceName: t.sourceNode ? t.sourceNode.name : '',
          sourceType: t.sourceNode ? t.sourceNode.type : '',
          targetParentName: t.targetParentName,
          targetParentId: t.targetParentId,
          childrenCount: (t.sourceChildren || []).length
        };
      }),
      singleTasks: (data.singleTasks || []).map(function (t) {
        return { sourceName: t.sourceNode ? t.sourceNode.name : '', targetNodeName: t.targetNodeName, targetNodeId: t.targetNodeId };
      }),
      exportedAt: new Date().toISOString()
    };

    var json = JSON.stringify(clean, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'auth-resource-sync-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function clearData() {
    if (!confirm('\u786E\u5B9A\u6E05\u9664\u6240\u6709\u91C7\u96C6\u6570\u636E\u548C\u540C\u6B65\u961F\u5217\uFF1F')) return;
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
      noDataEl.style.display = '';
      hasDataEl.style.display = 'none';
    } catch (e) { alert('\u6E05\u9664\u5931\u8D25: ' + e.message); }
  }

  init();
})();