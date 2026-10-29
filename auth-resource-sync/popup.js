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
  var snapCountEl = document.getElementById('popup-snap-count');
  var currentUrlEl = document.getElementById('current-url');
  var btnExport = document.getElementById('btn-export');
  var btnClear = document.getElementById('btn-clear');

  async function init() {
    // 版本号从 manifest 读，不要写死 —— 之前这里写死 v1.0，很快就过期了
    try {
      var verEl = document.getElementById('popup-version');
      if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) { /* 非扩展环境忽略 */ }

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
    // 用户权限同步的快照也要计数：只采集了账号快照时，
    // 若不计入，popup 会显示"暂无数据"并把「清除数据」按钮藏起来。
    var snapCount = (data.srcSnapshot ? 1 : 0) + (data.tgtSnapshot ? 1 : 0);

    if (srcCount === 0 && tgtCount === 0 && queueCount === 0 && snapCount === 0) {
      noDataEl.style.display = '';
      hasDataEl.style.display = 'none';
      return;
    }
    noDataEl.style.display = 'none';
    hasDataEl.style.display = '';

    if (srcCountEl) srcCountEl.textContent = srcCount + ' \u8282\u70B9';
    if (tgtCountEl) tgtCountEl.textContent = tgtCount + ' \u8282\u70B9';
    if (queueCountEl) queueCountEl.textContent = queueCount + ' \u6761';
    if (snapCountEl) snapCountEl.textContent = snapCount + ' \u4E2A';
  }

  /** 导出时只保留快照的关键字段，不带 detail（里面有手机号/邮箱等个人信息） */
  function trimSnapshot(s) {
    if (!s) return null;
    return {
      account: s.account,
      userId: s.userId,
      env: s.env,
      appIdList: s.appIdList,
      roleIdList: s.roleIdList,
      capturedAt: s.capturedAt
    };
  }

  /** 同上：只挑与权限变更相关的字段，绝不整对象 dump（防以后加了 detail 之类带出个人信息） */
  function trimUserSyncRecord(r) {
    if (!r) return null;
    return {
      at: r.at,
      host: r.host,
      account: r.account,
      userId: r.userId,
      before: r.before,
      after: r.after,
      srcHost: r.srcHost,
      srcAccount: r.srcAccount,
      verified: r.verified
    };
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
      // 用户权限同步的两个快照（只保留关键字段，不含 detail 里的手机号/邮箱）
      userSnapshots: {
        source: trimSnapshot(data.srcSnapshot || data.sourceSnapshot),
        target: trimSnapshot(data.tgtSnapshot || data.targetSnapshot)
      },
      // 最近一次用户权限同步的写入记录（写入前后的 ID 列表）。
      // 它本身不含手机号/邮箱等 detail 字段，可原样导出，作为"谁在哪个环境
      // 对哪个账号做了什么改动"的追责依据；只保留最近一次，故是单条而非历史。
      lastUserSync: trimUserSyncRecord(data.lastUserSync),
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
      // 交给 background 统一删（本扩展里唯一执行"清空"的地方）。
      // 清空后已打开页面的 content script 会通过 storage.onChanged 自行重置。
      var res = await chrome.runtime.sendMessage({ type: 'CLEAR_DATA' });
      if (!res || !res.success) throw new Error((res && res.error) || '未收到确认');
      noDataEl.style.display = '';
      hasDataEl.style.display = 'none';
    } catch (e) { alert('\u6E05\u9664\u5931\u8D25: ' + e.message); }
  }

  init();
})();