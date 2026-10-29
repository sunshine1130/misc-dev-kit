/**
 * Dict Sync - Popup Script v2
 */
(function () {
  'use strict';
  var STORAGE_KEY = 'dict_sync_data';

  var noDataEl = document.getElementById('no-data');
  var hasDataEl = document.getElementById('has-data');
  var summaryDictTypes = document.getElementById('summary-dict-types');
  var summaryDictValues = document.getElementById('summary-dict-values');
  var detailList = document.getElementById('detail-list');
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
      return result[STORAGE_KEY] || { dictTypes: [], dictValues: [], lastUpdated: 0 };
    } catch (e) { return { dictTypes: [], dictValues: [], lastUpdated: 0 }; }
  }

  function renderData(data) {
    var totalTypes = (data.dictTypes || []).reduce(function (s, g) { return s + (g.list ? g.list.length : 0); }, 0);
    var totalValues = (data.dictValues || []).reduce(function (s, g) { return s + (g.values ? g.values.length : 0); }, 0);

    if (totalTypes === 0 && totalValues === 0) {
      noDataEl.style.display = '';
      hasDataEl.style.display = 'none';
      return;
    }
    noDataEl.style.display = 'none';
    hasDataEl.style.display = '';
    summaryDictTypes.textContent = totalTypes;
    summaryDictValues.textContent = totalValues;

    var html = '';
    (data.dictTypes || []).forEach(function (g) {
      html += '<div class="detail-item"><span class="detail-item-name">📘 ' + esc(g.dictType || '未知') + '</span><span class="detail-item-count">' + (g.list ? g.list.length : 0) + ' 条</span></div>';
    });
    (data.dictValues || []).forEach(function (g) {
      html += '<div class="detail-item"><span class="detail-item-name">📗 ' + esc(g.dictType || g.dictName || g.dictTypeId) + '</span><span class="detail-item-count">' + (g.values ? g.values.length : 0) + ' 条</span></div>';
    });
    detailList.innerHTML = html || '<div style="color:#999;text-align:center;padding:10px;">无数据</div>';
  }

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function exportData(data) {
    var clean = { dictTypes: [], dictValues: [] };
    (data.dictTypes || []).forEach(function (g) {
      clean.dictTypes.push({ dictType: g.dictType, list: (g.list || []).map(function (d) {
        var o = {}; for (var k in d) { if (k !== '_sel') o[k] = d[k]; } return o;
      })});
    });
    (data.dictValues || []).forEach(function (g) {
      clean.dictValues.push({ dictTypeId: g.dictTypeId, dictType: g.dictType, dictName: g.dictName, values: (g.values || []).map(function (v) {
        var o = {}; for (var k in v) { if (k !== '_sel') o[k] = v[k]; } return o;
      })});
    });

    var json = JSON.stringify(clean, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'dict-sync-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function clearData() {
    if (!confirm('确定清除所有采集数据？')) return;
    try {
      // 直接通知 background 清除
      await chrome.runtime.sendMessage({ type: 'CLEAR_DATA' });
      // 通知 content script 刷新 UI
      try {
        var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].id) chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_DATA_MEMORY' });
      } catch (e) {}
      noDataEl.style.display = '';
      hasDataEl.style.display = 'none';
    } catch (e) { alert('清除失败: ' + e.message); }
  }

  init();
})();