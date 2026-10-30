/**
 * Dict Sync - Content Script
 * v2 — 勾选列表 + 选择性同步/删除 + 可靠持久化
 */
(function () {
  'use strict';

  // ==================== 常量 ====================
  var STORAGE_KEY = 'dict_sync_data';
  var INJECT_SCRIPT = chrome.runtime.getURL('inject.js');
  var PANEL_WIDTH = '380px';

  // ==================== 状态 ====================
  var isPanelOpen = false;
  var panelEl = null;
  var capturedDictTypes = [];   // [{ dictType, list: [{..., _sel:true}], _sel:true }]
  var capturedDictValues = [];  // [{ dictTypeId, dictType, dictName, values: [{..., _sel:true}], _sel:true }]
  var syncStatus = 'idle';
  var syncStats = { ok: 0, warn: 0, err: 0 };  // 同步统计
  var syncLog = [];
  var _reqIdCounter = 0;
  var _apiBaseOrigin = null;

  // 只读环境的临时写入豁免：**只记内存、只对当前宿主生效**，刷新页面即失效。
  // 为什么不做成持久开关：一个"打开过一次就一直在那"的写入开关，迟早会在
  // 没人注意的时候放行一次生产写入 —— 那种事故没人会当场发现。
  var _writeOverrideHost = '';

  // ==================== 初始化 ====================
  var isDictPage = false;
  var _lastUrl = '';

  function checkDictPage() {
    var url = window.location.href;
    if (url === _lastUrl) return isDictPage;
    _lastUrl = url;
    // 匹配字典管理页面 /MF_base/dict 或 /MF_base/dictValue/xxx
    isDictPage = /\/MF_base\/dict(\/|$|Value)/.test(url);
    return isDictPage;
  }

  async function init() {
    checkDictPage();
    if (!isDictPage) {
      // 非字典页面：不创建面板，但监听 URL 变化（SPA 路由切换可能进入字典页）
      startUrlWatcher();
      return;
    }

    injectPageScript();
    await loadStoredData();
    ensureSelectionFlags();
    window.addEventListener('message', handlePageMessage);
    createFloatingPanel();
    log('[Dict Sync] Init done, types:', countTypes(), 'values:', countValues());
    startUrlWatcher();
  }

  /**
   * 监听 SPA 路由变化：进入字典页时创建面板，离开时移除
   */
  function startUrlWatcher() {
    var lastChecked = window.location.href;
    setInterval(function () {
      var current = window.location.href;
      if (current === lastChecked) return;
      lastChecked = current;
      var wasDictPage = isDictPage;
      checkDictPage();

      if (!wasDictPage && isDictPage) {
        // 从非字典页进入字典页
        if (!panelEl) {
          injectPageScript();
          loadStoredData().then(function () {
            ensureSelectionFlags();
            createFloatingPanel();
          });
        }
      } else if (wasDictPage && !isDictPage) {
        // 离开字典页，移除面板
        if (panelEl) {
          panelEl.remove();
          panelEl = null;
          isPanelOpen = false;
        }
      }
    }, 800);
  }

  function injectPageScript() {
    if (document.getElementById('dict-sync-inject')) return;
    var script = document.createElement('script');
    script.id = 'dict-sync-inject';
    script.src = INJECT_SCRIPT;
    script.onload = function () { script.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  function handlePageMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'dict-sync-inject') return;
    pulseToggle();
  }

  // ==================== 辅助计数 ====================
  function countTypes() {
    var n = 0;
    capturedDictTypes.forEach(function (g) { n += (g.list ? g.list.length : 0); });
    return n;
  }
  function countValues() {
    var n = 0;
    capturedDictValues.forEach(function (g) { n += (g.values ? g.values.length : 0); });
    return n;
  }
  function countSelectedTypes() {
    var n = 0;
    capturedDictTypes.forEach(function (g) {
      if (g._sel === false) return;
      (g.list || []).forEach(function (d) { if (d._sel !== false) n++; });
    });
    return n;
  }
  function countSelectedValues() {
    var n = 0;
    capturedDictValues.forEach(function (g) {
      if (g._sel === false) return;
      (g.values || []).forEach(function (v) { if (v._sel !== false) n++; });
    });
    return n;
  }

  // ==================== 选择标记兼容 ====================
  // 旧数据没有 _sel 标记，加载后补上（默认全选）
  function ensureSelectionFlags() {
    capturedDictTypes.forEach(function (g) {
      if (g._sel === undefined) g._sel = true;
      (g.list || []).forEach(function (d) { if (d._sel === undefined) d._sel = true; });
    });
    capturedDictValues.forEach(function (g) {
      if (g._sel === undefined) g._sel = true;
      (g.values || []).forEach(function (v) { if (v._sel === undefined) v._sel = true; });
    });
  }

  // ==================== 存储管理（直接读写 chrome.storage.local + onChanged 实时同步） ====================

  /**
   * 从 storage 加载数据到内存
   */
  async function loadStoredData() {
    try {
      var result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        capturedDictTypes = result[STORAGE_KEY].dictTypes || [];
        capturedDictValues = result[STORAGE_KEY].dictValues || [];
        ensureSelectionFlags();
        log('[Dict Sync] Loaded:', countTypes(), 'types,', countValues(), 'values');
        return true;
      }
      log('[Dict Sync] Storage empty');
      return false;
    } catch (e) {
      console.error('[Dict Sync] Load error:', e);
      return false;
    }
  }

  /**
   * 保存内存数据到 storage
   */
  async function saveStoredData() {
    try {
      var obj = {};
      obj[STORAGE_KEY] = {
        dictTypes: capturedDictTypes,
        dictValues: capturedDictValues,
        lastUpdated: Date.now()
      };
      await chrome.storage.local.set(obj);
      log('[Dict Sync] Saved:', countTypes(), 'types,', countValues(), 'values');
    } catch (e) {
      console.error('[Dict Sync] Save error:', e);
    }
  }

  /**
   * 监听其他标签页的 storage 变更 → 自动同步内存 + 刷新 UI
   */
  chrome.storage.onChanged.addListener(function (changes, namespace) {
    if (namespace !== 'local') return;
    if (!changes[STORAGE_KEY]) return;

    var newVal = changes[STORAGE_KEY].newValue;
    if (!newVal) return;

    // 避免自己触发自己（但即使触发了也没关系，数据是一致的）
    capturedDictTypes = newVal.dictTypes || [];
    capturedDictValues = newVal.dictValues || [];
    ensureSelectionFlags();
    refreshPanel();
    log('[Dict Sync] Auto-synced from storage change:', countTypes(), 'types,', countValues(), 'values');
  });

  /**
   * 清除全部数据
   */
  async function clearStoredData() {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch (e) { /* ignore */ }
  }

  // ==================== 与 inject.js 通信 ====================
  function nextReqId() { return 'req_' + (++_reqIdCounter) + '_' + Date.now(); }

  function sendToInject(msg) {
    return new Promise(function (resolve, reject) {
      var requestId = nextReqId();
      msg.requestId = requestId;
      msg.source = 'dict-sync-content';
      var timeout = setTimeout(function () {
        window.removeEventListener('message', handler);
        reject(new Error('Timeout: ' + msg.type));
      }, 15000);

      function handler(event) {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'dict-sync-inject') return;
        if (event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
      window.addEventListener('message', handler);
      window.postMessage(msg, '*');
    });
  }

  async function getCachedData() {
    try {
      var resp = await sendToInject({ type: 'GET_CACHED_DATA' });
      var payload = resp.payload || null;
      if (payload) {
        var apiUrl = (payload.dictList && payload.dictList.url) || (payload.dictValueList && payload.dictValueList.url);
        if (apiUrl) {
          try { _apiBaseOrigin = new URL(apiUrl, window.location.origin).origin; } catch (e) {}
        }
      }
      return payload;
    } catch (e) { console.error('[Dict Sync] getCachedData:', e); return null; }
  }

  async function ensureApiBaseOrigin() {
    if (_apiBaseOrigin) return _apiBaseOrigin;
    addLog('🔍 检测 API 地址...', 'info');
    await getCachedData();
    if (!_apiBaseOrigin) {
      addLog('⚠ 未检测到 API 调用，使用页面地址。建议先搜索', 'warn');
      _apiBaseOrigin = window.location.origin;
    }
    addLog('🔗 API: ' + _apiBaseOrigin, 'info');
    return _apiBaseOrigin;
  }

  /**
   * API 层的写入兜底：写接口 + 只读环境 = 抛错。
   *
   * 为什么单独抽成一个函数：它是"按钮置灰"之外真正的安全边界，而按钮置灰只是
   * 让人看得见。抽出来才能用 node 直接单测这段组合逻辑（见 tests/write-guard.test.cjs），
   * 否则删掉它不会有任何测试变红。
   *
   * 注意它**只拦写**：只读环境下采集/查询照常可用 —— 只读的语义是"不能改"，
   * 不是"不能用"。把读也拦掉会让人在生产连数据都看不到。
   */
  function guardWrite(apiPath) {
    if (!EnvGuard.isWritePath(apiPath)) return;
    var why = writeBlockedReason();
    if (why) throw new Error('已阻止写入：' + why);
  }

  async function callApi(apiPath, data) {
    guardWrite(apiPath);
    var token = localStorage.getItem('Admin-Token');
    token = token ? 'Bearer ' + token : '';
    var fullPath = _apiBaseOrigin ? (_apiBaseOrigin + apiPath) : apiPath;
    var resp = await sendToInject({ type: 'CALL_API', apiPath: fullPath, data: data, token: token });
    if (resp.success) return resp.data;
    throw new Error(resp.error || 'API error');
  }

  // ==================== 环境闸（写入限制） ====================
  /**
   * 当前环境是否被禁止写入。返回空串表示允许。
   *
   * 判定顺序：先看白名单（EnvGuard），再看本页是否开了豁免。
   * 白名单外的环境默认只读 —— 默认拒绝而不是默认放行，这是刻意的：
   * 字典同步是往库里写配置，写错生产的代价远大于"多问一句"。
   */
  function writeBlockedReason() {
    var host = window.location.hostname;
    if (EnvGuard.isWriteAllowed(host)) return '';
    if (_writeOverrideHost && _writeOverrideHost === host) return '';
    return EnvGuard.writeBlockReason(host);
  }

  /**
   * 解除本环境的只读限制 —— 两步确认。
   * 第一步 confirm 讲清后果，第二步要求手敲完整域名（防手滑、也防别人代点）。
   */
  function enableWriteOverride() {
    var host = window.location.hostname;
    // 文案必须如实说明当前是哪类环境：只读覆盖 uat/stg/prod/未知多类，
    // 一律叫"生产"会让人以为插件认错了环境。
    if (!window.confirm(
      '\u26A0 当前环境「' + host + '」是' + EnvGuard.envLabel(host) + '环境，默认禁止写入。\n\n' +
      '开启后将允许本扩展修改该环境的字典配置 ——\n' +
      '这是真实数据，改动会立即生效，本工具没有撤销。\n\n' +
      '确定要开启吗？'
    )) return;

    var typed = window.prompt(
      '为避免误操作，请输入当前环境的完整域名以确认：\n' + host, '');
    if (typed === null) { addLog('写入开关：已取消', 'warn'); refreshPanel(); return; }
    if (String(typed).trim().toLowerCase() !== host.toLowerCase()) {
      addLog('✗ 写入开关：域名输入不一致，未开启写入', 'error');
      refreshPanel(); return;
    }

    _writeOverrideHost = host;
    addLog('\u26A0 已对 ' + host + ' 开启写入（仅本次页面会话有效，刷新即恢复只读）', 'warn');
    refreshPanel();
  }

  function disableWriteOverride() {
    _writeOverrideHost = '';
    addLog('已恢复只读', 'success');
    refreshPanel();
  }

  // ==================== 日志 ====================
  function addLog(msg, type) {
    syncLog.push({ msg: msg, type: type, time: new Date().toLocaleTimeString() });
    if (syncLog.length > 500) syncLog.shift();
    console.log('[Dict Sync] ' + msg);
    // 统计同步结果
    if (type === 'success' || type === 'ok') syncStats.ok++;
    else if (type === 'warn' || type === 'skip') syncStats.warn++;
    else if (type === 'error' || type === 'err') syncStats.err++;
  }
  function resetStats() { syncStats = { ok: 0, warn: 0, err: 0 }; }
  function log() { console.log.apply(console, arguments); }

  // ==================== 采集 ====================
  async function fetchValuesForDict(dict, silent) {
    try {
      var result = await callApi('/base/dictData/listPage', { dictTypeId: dict.id, pageNum: 1, pageSize: 500 });
      if (result.code !== 200 || !result.data) {
        if (!silent) addLog('  ⚠ 无值 [' + (dict.dictType || dict.id) + ']', 'warn');
        return 0;
      }
      var list = result.data.list || [];
      var info = result.data.info || {};
      if (list.length === 0) return 0;

      var dictTypeId = String(dict.id);
      var existing = capturedDictValues.find(function (d) { return d.dictTypeId === dictTypeId; });

      if (existing) {
        var existingMap = {};
        existing.values.forEach(function (v) { existingMap[v.id] = v; });

        var newCount = 0;
        var updatedCount = 0;

        list.forEach(function (fresh) {
          var old = existingMap[fresh.id];
          if (old) {
            // 🔑 已存在 → 更新字段（备注等可能已变更）
            var changed = false;
            var fields = ['dictLabel', 'dictLabelEn', 'dictValue', 'isDefault', 'dictSort', 'listClass', 'status', 'remark', 'createTime'];
            fields.forEach(function (f) {
              if (fresh[f] !== undefined && old[f] !== fresh[f]) { old[f] = fresh[f]; changed = true; }
            });
            if (changed) updatedCount++;
          } else {
            // 新增
            fresh._sel = true;
            existing.values.push(fresh);
            newCount++;
          }
        });

        existing.timestamp = Date.now();
        if (newCount > 0 || updatedCount > 0) {
          if (!silent) {
            var parts = [];
            if (newCount > 0) parts.push('+' + newCount + ' 新');
            if (updatedCount > 0) parts.push('↻' + updatedCount + ' 更新');
            addLog('  ✓ ' + parts.join(', '), 'success');
          }
        }
        return newCount;
      } else {
        list.forEach(function (v) { v._sel = true; });
        capturedDictValues.push({
          dictTypeId: dictTypeId, dictType: info.dictType || dict.dictType || '',
          dictName: info.dictName || dict.dictName || '',
          values: list.slice(), timestamp: Date.now(), sourceUrl: window.location.href, _sel: true
        });
        return list.length;
      }
    } catch (e) {
      if (!silent) addLog('  ✗ 取值异常: ' + e.message, 'error');
      return 0;
    }
  }

  async function captureAll() {
    disableSyncBtn(true);
    try {
      var cached = await getCachedData();
      if (!cached || !cached.dictList || !cached.dictList.data || !cached.dictList.data.list || cached.dictList.data.list.length === 0) {
        addLog('⚠ 未检测到字典列表，请先搜索', 'warn');
        return;
      }

      var list = cached.dictList.data.list;
      try { _apiBaseOrigin = new URL(cached.dictList.url, window.location.origin).origin; } catch (e) {}

      // ── Step 1: 字典类型（带 _sel=true） ──
      var groups = {};
      list.forEach(function (item) {
        var key = item.dictType || '__unknown__';
        if (!groups[key]) groups[key] = [];
        item._sel = true;
        groups[key].push(item);
      });

      var addedTypes = 0;
      var allCapturedDicts = [];  // 本次采集到的所有字典（每个 group 的全部 items）

      Object.keys(groups).forEach(function (dictType) {
        var items = groups[dictType];
        var existingIdx = -1;
        for (var i = 0; i < capturedDictTypes.length; i++) {
          if (capturedDictTypes[i].dictType === dictType) { existingIdx = i; break; }
        }

        if (existingIdx >= 0) {
          var existing = capturedDictTypes[existingIdx];
          var existingMap = {};
          existing.list.forEach(function (d) { existingMap[d.id] = d; });

          var newCount = 0;
          var updatedCount = 0;

          items.forEach(function (fresh) {
            var old = existingMap[fresh.id];
            if (old) {
              // 🔑 已存在 → 更新可能变更的字段
              var changed = false;
              ['dictName', 'dictType', 'status', 'remark', 'createTime'].forEach(function (f) {
                if (fresh[f] !== undefined && old[f] !== fresh[f]) { old[f] = fresh[f]; changed = true; }
              });
              if (changed) updatedCount++;
            } else {
              fresh._sel = true;
              existing.list.push(fresh);
              newCount++;
            }
          });

          existing.timestamp = Date.now();
          if (newCount > 0 || updatedCount > 0) {
            addedTypes += newCount;
            var p = [];
            if (newCount > 0) p.push('+' + newCount + ' 新');
            if (updatedCount > 0) p.push('↻' + updatedCount + ' 更新');
            addLog('  ' + dictType + ': ' + p.join(', '), 'info');
          }
          // 🔑 所有 items 都是本次采集到的（用于后续拉取值）
          allCapturedDicts.push.apply(allCapturedDicts, items);
        } else {
          var group = { dictType: dictType, list: items.slice(), timestamp: Date.now(), sourceUrl: window.location.href, _sel: true };
          capturedDictTypes.push(group);
          addedTypes += items.length;
          allCapturedDicts.push.apply(allCapturedDicts, items);
        }
      });

      addLog('📘 字典类型: +' + addedTypes + ' 条 (' + Object.keys(groups).length + ' 组)', 'success');
      await saveStoredData();

      if (allCapturedDicts.length === 0) {
        addLog('ℹ 无字典需要拉取值', 'info');
        return;
      }

      // ── Step 2: 拉取值 ──
      await ensureApiBaseOrigin();
      var totalNewValues = 0, failed = 0;
      addLog('📗 拉取 ' + allCapturedDicts.length + ' 个字典的值...', 'info');

      for (var i = 0; i < allCapturedDicts.length; i++) {
        var dict = allCapturedDicts[i];
        var label = dict.dictType || dict.dictName || dict.id;
        addLog('  [' + (i + 1) + '/' + allCapturedDicts.length + '] ' + label, 'info');
        refreshPanel();

        try {
          var n = await fetchValuesForDict(dict, false);
          totalNewValues += n;
          if (n > 0) { addLog('    ✓ +' + n + ' 条值', 'success'); await saveStoredData(); }
        } catch (e) { failed++; addLog('    ✗ ' + e.message, 'error'); }
        await sleep(200);
        refreshPanel();
      }

      var msg = '✅ 完成！类型 +' + addedTypes + ' 值 +' + totalNewValues;
      if (failed > 0) msg += ' (' + failed + ' 失败)';
      addLog(msg, failed > 0 ? 'warn' : 'success');
      await saveStoredData();
    } catch (e) {
      addLog('✗ 采集异常: ' + e.message, 'error');
      console.error('[Dict Sync] captureAll:', e);
      try { await saveStoredData(); } catch (e2) {}
    } finally {
      disableSyncBtn(false);
      refreshPanel();
    }
  }

  // 手动补充采集（字典值页面）
  async function captureDictValuesPage() {
    try {
      var cached = await getCachedData();
      if (!cached || !cached.dictValueList || !cached.dictValueList.data || !cached.dictValueList.data.list) {
        addLog('⚠ 未检测到字典值数据，请先搜索', 'warn');
        return;
      }
      var data = cached.dictValueList.data;
      var list = data.list || [];
      var info = data.info || {};
      var dictTypeId = cached.dictValueList.dictTypeId || '';
      if (!dictTypeId) { addLog('⚠ 无 dictTypeId', 'warn'); return; }

      var existing = capturedDictValues.find(function (d) { return d.dictTypeId === dictTypeId; });
      if (existing) {
        var existingIds = {};
        existing.values.forEach(function (v) { existingIds[v.id] = true; });
        var newItems = list.filter(function (v) { return !existingIds[v.id]; });
        newItems.forEach(function (v) { v._sel = true; });
        if (newItems.length > 0) {
          existing.values.push.apply(existing.values, newItems);
          existing.timestamp = Date.now();
          addLog('✓ +' + newItems.length + ' 条值 (' + (info.dictType || dictTypeId) + ')', 'success');
        } else { addLog('ℹ 无新增值', 'info'); }
      } else {
        list.forEach(function (v) { v._sel = true; });
        capturedDictValues.push({
          dictTypeId: dictTypeId, dictType: info.dictType || '', dictName: info.dictName || '',
          values: list.slice(), timestamp: Date.now(), sourceUrl: window.location.href, _sel: true
        });
        addLog('✓ ' + list.length + ' 条值 (' + (info.dictType || dictTypeId) + ')', 'success');
      }
      await saveStoredData();
      refreshPanel();
    } catch (e) { addLog('✗ ' + e.message, 'error'); }
  }

  // ==================== 同步 ====================
  async function searchDictType(dictType) {
    var result = await callApi('/base/dictType/listPage', { dictType: dictType, pageNum: 1, pageSize: 10 });
    if (result.code === 200 && result.data && result.data.list && result.data.list.length > 0) return result.data.list[0];
    return null;
  }

  /**
   * 搜索字典值：同一字典下按 dictValue 精确匹配，label 仅作为待更新字段。
   */
  async function searchDictValue(dictTypeId, dictValue) {
    var pageNum = 1;
    var pageSize = 100;
    while (true) {
      var result = await callApi('/base/dictData/listPage', { dictTypeId: dictTypeId, dictValue: dictValue, pageNum: pageNum, pageSize: pageSize });
      if (result.code !== 200 || !result.data || !Array.isArray(result.data.list)) {
        throw new Error('查询字典值失败:' + result.code);
      }
      var list = result.data.list;
      for (var i = 0; i < list.length; i++) {
        // 接口可能模糊查询，不能直接使用第一条结果。
        if (String(list[i].dictValue) === String(dictValue)) return list[i];
      }
      if (list.length < pageSize || (result.data.total !== undefined && pageNum * pageSize >= Number(result.data.total))) return null;
      pageNum++;
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function syncSelected() {
    if (syncStatus === 'syncing') { addLog('⚠ 同步中...', 'warn'); return; }

    // 环境闸放在最前面，而不是等跑到写接口才拦：只读环境点下去应当立刻被
    // 明确告知原因，而不是先"采集中"转一圈再报一堆错。
    var blockedWhy = writeBlockedReason();
    if (blockedWhy) {
      addLog('✗ 已阻止写入：' + blockedWhy, 'error');
      refreshPanel();
      return;
    }

    var selTypes = countSelectedTypes();
    var selValues = countSelectedValues();
    if (selTypes === 0 && selValues === 0) { addLog('⚠ 没有勾选任何数据', 'warn'); return; }

    syncStatus = 'syncing';
    resetStats();
    syncLog = [];
    refreshPanel();

    log('[Dict Sync] Syncing:', selTypes, 'types,', selValues, 'values');

    try {
      await ensureApiBaseOrigin();
      addLog('🚀 开始同步选中数据...', 'info');
      addLog('📋 字典类型: ' + selTypes + ' 条 | 字典值: ' + selValues + ' 条', 'info');

      var idMap = {};

      // ── Step 1: 同步字典类型（先查后改） ──
      for (var gi = 0; gi < capturedDictTypes.length; gi++) {
        var g = capturedDictTypes[gi];
        if (g._sel === false) continue;
        for (var di = 0; di < g.list.length; di++) {
          var dict = g.list[di];
          if (dict._sel === false) continue;

          var payload = {
            dictName: dict.dictName,
            dictType: dict.dictType,
            belongingProjectList: Array.isArray(dict.belongingProjectList) ? dict.belongingProjectList
              : (Array.isArray(dict.belongingProject) ? dict.belongingProject : []),
            status: dict.status !== undefined ? dict.status : 0,
            remark: dict.remark || ''
          };

          try {
            // 🔑 先查是否已存在
            var existingType = await searchDictType(dict.dictType);
            if (existingType) {
              // 已存在 → 走编辑
              payload.id = existingType.id;
              var editRes = await callApi('/base/dictType/edit', payload);
              if (editRes.code === 200) {
                idMap[dict.id] = existingType.id;
                addLog('✎ 类型 [' + dict.dictType + '] 更新 (ID:' + existingType.id + ')', 'success');
              } else {
                idMap[dict.id] = existingType.id;
                addLog('⚠ 类型 [' + dict.dictType + '] 更新返回:' + editRes.code, 'warn');
              }
            } else {
              // 不存在 → 新增
              var addRes = await callApi('/base/dictType/add', payload);
              if (addRes.code === 200) {
                var newDict = await searchDictType(dict.dictType);
                if (newDict) { idMap[dict.id] = newDict.id; }
                addLog('＋ 类型 [' + dict.dictType + '] 新建 (ID:' + (newDict ? newDict.id : '?') + ')', 'success');
              } else {
                addLog('✗ 类型 [' + dict.dictType + '] 新增失败:' + addRes.code, 'error');
              }
            }
          } catch (e) { addLog('✗ 类型 [' + dict.dictType + '] ' + e.message, 'error'); }
          await sleep(250);
          refreshPanel();
        }
      }

      addLog('--- ID 映射: ' + Object.keys(idMap).length + ' 条 ---', 'info');

      // ── Step 2: 同步字典值（先查后改） ──
      for (var vi = 0; vi < capturedDictValues.length; vi++) {
        var vg = capturedDictValues[vi];
        if (vg._sel === false) continue;
        var tid = idMap[vg.dictTypeId];
        if (!tid) {
          var ex = await searchDictType(vg.dictType);
          if (ex) { idMap[vg.dictTypeId] = ex.id; tid = ex.id; addLog('🔍 找到类型 [' + vg.dictType + '] ID:' + ex.id, 'info'); }
          else { addLog('✗ 跳过 [' + vg.dictType + ']: 无对应字典类型', 'error'); continue; }
        }

        for (var vdi = 0; vdi < vg.values.length; vdi++) {
          var val = vg.values[vdi];
          if (val._sel === false) continue;

          var vp = {
            dictTypeId: tid, dictLabel: val.dictLabel, dictLabelEn: val.dictLabelEn || '',
            dictValue: val.dictValue, isDefault: val.isDefault || 'N',
            dictSort: val.dictSort !== undefined ? val.dictSort : 0,
            listClass: val.listClass || 'default', status: val.status !== undefined ? val.status : 0,
            remark: val.remark || ''
          };

          try {
            // 🔑 按 value 判断是否存在，label 不同也更新目标记录
            var existingVal = await searchDictValue(tid, val.dictValue);
            if (existingVal) {
              vp.id = existingVal.id;
              var evRes = await callApi('/base/dictData/edit', vp);
              if (evRes.code === 200) addLog('✎ 值 [' + val.dictLabel + '] 更新', 'success');
              else addLog('⚠ 值 [' + val.dictLabel + '] 更新返回:' + evRes.code, 'warn');
            } else {
              var avRes = await callApi('/base/dictData/add', vp);
              if (avRes.code === 200) addLog('＋ 值 [' + val.dictLabel + '] 新建', 'success');
              else addLog('⚠ 值 [' + val.dictLabel + '] 新建返回:' + avRes.code, 'warn');
            }
          } catch (e) { addLog('✗ 值 [' + val.dictLabel + '] ' + e.message, 'error'); }
          await sleep(150);
          refreshPanel();
        }
      }

      // 🔑 最终汇总
      var total = syncStats.ok + syncStats.warn + syncStats.err;
      var msg = '✅ 同步完成！共 ' + total + ' 条：';
      if (syncStats.ok > 0) msg += '成功 ' + syncStats.ok + ' ';
      if (syncStats.warn > 0) msg += '跳过 ' + syncStats.warn + ' ';
      if (syncStats.err > 0) msg += '失败 ' + syncStats.err + ' ';
      addLog(msg, syncStats.err > 0 ? 'warn' : 'success');
      syncStatus = 'done';
    } catch (e) {
      addLog('❌ 同步异常: ' + e.message, 'error');
      syncStatus = 'error';
    } finally { refreshPanel(); }
  }

  // ==================== 删除选中 ====================
  async function deleteSelected() {
    var selTypes = countSelectedTypes();
    var selValues = countSelectedValues();
    var total = countTypes() + countValues();
    if (selTypes + selValues === 0) { addLog('⚠ 没有勾选任何数据', 'warn'); return; }
    if (selTypes + selValues === total) {
      // 全删
      capturedDictTypes = [];
      capturedDictValues = [];
      addLog('🗑 已清除全部数据', 'info');
    } else {
      // 删勾选的
      for (var gi = capturedDictTypes.length - 1; gi >= 0; gi--) {
        var g = capturedDictTypes[gi];
        g.list = (g.list || []).filter(function (d) { return d._sel === false; });
        if (g.list.length === 0) capturedDictTypes.splice(gi, 1);
      }
      for (var vi = capturedDictValues.length - 1; vi >= 0; vi--) {
        var vg = capturedDictValues[vi];
        vg.values = (vg.values || []).filter(function (v) { return v._sel === false; });
        if (vg.values.length === 0) capturedDictValues.splice(vi, 1);
      }
      addLog('🗑 已删除 ' + (selTypes + selValues) + ' 条选中数据', 'info');
    }
    await saveStoredData();
    refreshPanel();
  }

  // 清除全部
  async function clearAll() {
    capturedDictTypes = [];
    capturedDictValues = [];
    syncLog = [];
    syncStatus = 'idle';
    _apiBaseOrigin = null;
    await clearStoredData();
    refreshPanel();
    addLog('🗑 已清除全部', 'info');
  }

  // ==================== 全选/取消全选 ====================
  function toggleSelectAll() {
    var allSel = countSelectedTypes() + countSelectedValues();
    var total = countTypes() + countValues();
    var newVal = allSel < total;

    capturedDictTypes.forEach(function (g) {
      g._sel = newVal;
      (g.list || []).forEach(function (d) { d._sel = newVal; });
    });
    capturedDictValues.forEach(function (g) {
      g._sel = newVal;
      (g.values || []).forEach(function (v) { v._sel = newVal; });
    });
    saveStoredData();
    refreshPanel();
  }

  // ==================== 浮动面板 ====================
  function createFloatingPanel() {
    try {
      panelEl = document.createElement('div');
      panelEl.id = 'dict-sync-panel';
      panelEl.innerHTML =
        '<div id="ds-toggle" class="dict-sync-btn">' +
          '<span class="dict-sync-icon">📋</span>' +
          '<span id="ds-badge" class="dict-sync-badge" style="display:none">0</span>' +
        '</div>' +
        '<div id="ds-body" class="dict-sync-body" style="display:none;width:' + PANEL_WIDTH + '">' +
          // 头部：标题 + 版本号 + 当前环境 + 只读状态 / 写入开关。
          // 版本号从 manifest 读，不再手抄 —— 同事报问题时第一句就能自查版本。
          // 环境与只读状态放头部（而不是藏在设置里）：误写生产之前，这是最后一眼。
          '<div id="ds-header" class="dict-sync-header">' +
            '<span>Dict Sync <span id="ds-version" style="font-size:10px;font-weight:500;opacity:.75"></span></span>' +
            '<span id="ds-env" style="font-size:10px;font-weight:500;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.18)"></span>' +
            '<span id="ds-write-lock" style="display:none;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.24)"></span>' +
            '<button id="ds-write-toggle" style="display:none;font-size:10px;font-weight:600;padding:2px 7px;border:none;border-radius:8px;background:rgba(255,255,255,.24);color:#fff;cursor:pointer;font-family:inherit">开启写入</button>' +
            '<span id="ds-close" class="dict-sync-close">✕</span>' +
          '</div>' +
          '<div id="ds-content" class="dict-sync-content">' +
            // ── 工具栏 ──
            '<div class="ds-toolbar">' +
              '<label class="ds-check-all"><input type="checkbox" id="ds-select-all"> 全选</label>' +
              '<span class="ds-summary">📘<b id="ds-type-cnt">0</b> 📗<b id="ds-val-cnt">0</b></span>' +
              '<span style="flex:1"></span>' +
              '<button id="ds-sync-sel" class="ds-btn ds-btn-sm ds-btn-primary">📤 同步选中</button>' +
              '<button id="ds-del-sel" class="ds-btn ds-btn-sm ds-btn-danger">🗑 删除选中</button>' +
              '<button id="ds-help" class="ds-btn ds-btn-sm" title="使用说明" style="padding:2px 6px;font-size:11px">❓</button>' +
            '</div>' +
            // ── 数据列表 ──
            '<div id="ds-list" class="ds-list"></div>' +
            // ── 操作按钮 ──
            '<div class="ds-divider"></div>' +
            '<div class="ds-actions">' +
              '<button id="ds-capture" class="ds-btn ds-btn-primary" style="flex:2">📥 一键采集</button>' +
              '<button id="ds-clear-all" class="ds-btn ds-btn-danger" style="flex:1">🗑 清除</button>' +
            '</div>' +
            // ── 同步结果条 ──
            '<div id="ds-result" class="ds-result-bar" style="display:none"></div>' +
            // ── 可折叠日志 ──
            '<div id="ds-log-wrap" class="ds-log-wrap">' +
              '<div class="ds-log-title" id="ds-log-toggle" style="cursor:pointer">' +
                '<span id="ds-log-label">📋 同步日志</span>' +
                '<span id="ds-log-count"></span>' +
                '<span style="margin-left:auto;font-size:10px">▲ 收起</span>' +
              '</div>' +
              '<div id="ds-log" class="dict-sync-log"></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(panelEl);

      // 版本号从 manifest 读，不手抄：同事报问题时第一句就能自查版本
      var vEl = document.getElementById('ds-version');
      if (vEl) vEl.textContent = 'v' + chrome.runtime.getManifest().version;

      // 事件绑定
      safeBind('ds-toggle', 'click', function () {
        isPanelOpen = !isPanelOpen;
        if (isPanelOpen) {
          // 🔑 每次打开面板从 storage 拉最新数据
          loadStoredData().then(function () { refreshPanel(); });
        } else {
          refreshPanel();
        }
      });
      safeBind('ds-close', 'click', function () { isPanelOpen = false; refreshPanel(); });
      safeBind('ds-select-all', 'change', function () { toggleSelectAll(); });
      safeBind('ds-sync-sel', 'click', syncSelected);
      safeBind('ds-del-sel', 'click', deleteSelected);
      safeBind('ds-help', 'click', function () {
        window.open(chrome.runtime.getURL('help.html'), '_blank');
      });
      safeBind('ds-write-toggle', 'click', function () {
        if (_writeOverrideHost === window.location.hostname) disableWriteOverride();
        else enableWriteOverride();
      });
      safeBind('ds-capture', 'click', captureAll);
      safeBind('ds-clear-all', 'click', clearAll);
      // 日志折叠
      safeBind('ds-log-toggle', 'click', function () {
        var logBody = document.getElementById('ds-log');
        var label = document.getElementById('ds-log-label');
        if (!logBody) return;
        if (logBody.style.display === 'none') {
          logBody.style.display = '';
          if (label) label.textContent = '📋 同步日志';
          document.getElementById('ds-log-toggle').querySelector('span:last-child').textContent = '▲ 收起';
        } else {
          logBody.style.display = 'none';
          if (label) label.textContent = '📋 同步日志（已折叠）';
          document.getElementById('ds-log-toggle').querySelector('span:last-child').textContent = '▼ 展开';
        }
      });

      // 🔑 拖拽移动
      setupDrag();

      // 列表委托
      var listEl = document.getElementById('ds-list');
      if (listEl) {
        listEl.addEventListener('click', function (e) {
          var cb = e.target.closest && e.target.closest('.ds-item-cb');
          if (cb) {
            var type = cb.getAttribute('data-type');
            var id = cb.getAttribute('data-id');
            var gid = cb.getAttribute('data-gid');
            toggleItem(type, gid, id);
          }
          var expander = e.target.closest && e.target.closest('.ds-group-expand');
          if (expander) {
            var gid2 = expander.getAttribute('data-gid');
            toggleGroupExpand(gid2);
          }
        });
      }

      refreshPanel();
    } catch (e) { console.error('[Dict Sync] Panel create:', e); }
  }

  function safeBind(id, event, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
    else console.error('[Dict Sync] Element not found:', id);
  }

  var expandedGroups = {};

  function toggleGroupExpand(gid) {
    expandedGroups[gid] = !expandedGroups[gid];
    renderList();
  }

  function toggleItem(type, gid, id) {
    // 🔑 分组头 checkbox：批量切换该组下所有项 + 关联的字典值
    if (type === 'type-group') {
      var newState = false;
      for (var i = 0; i < capturedDictTypes.length; i++) {
        var g = capturedDictTypes[i];
        if ((g.dictType || ('__type_' + i)) === gid) {
          var allSel = g.list.every(function (d) { return d._sel !== false; });
          // 检查关联值是否也全选
          var anyValue = false, allValuesSel = true;
          g.list.forEach(function (d) {
            var vg = findValueGroup(d.id);
            if (vg && vg.values.length > 0) {
              anyValue = true;
              if (!vg.values.every(function (v) { return v._sel !== false; })) allValuesSel = false;
            }
          });
          var allSelCombined = allSel && (!anyValue || allValuesSel);
          newState = !allSelCombined;

          g._sel = newState;
          g.list.forEach(function (d) { d._sel = newState; });

          // 同步切换关联的字典值
          g.list.forEach(function (d) {
            var vg = findValueGroup(d.id);
            if (vg) {
              vg._sel = newState;
              vg.values.forEach(function (v) { v._sel = newState; });
            }
          });
          break;
        }
      }
      saveStoredData();
      refreshPanel();
      return;
    }

    if (type === 'value-group') {
      var newState = false;
      for (var i = 0; i < capturedDictValues.length; i++) {
        var g2 = capturedDictValues[i];
        if ((g2.dictTypeId || ('__val_' + i)) === gid) {
          var allSel = g2.values.every(function (v) { return v._sel !== false; });
          newState = !allSel;
          g2._sel = newState;
          g2.values.forEach(function (v) { v._sel = newState; });
          break;
        }
      }
      saveStoredData();
      refreshPanel();
      return;
    }

    // 单条项目 checkbox
    if (type === 'type') {
      for (var i = 0; i < capturedDictTypes.length; i++) {
        var g = capturedDictTypes[i];
        if (g.dictType === gid) {
          for (var j = 0; j < g.list.length; j++) {
            if (String(g.list[j].id) === id) { g.list[j]._sel = !g.list[j]._sel; break; }
          }
          // 检查是否全组都选了
          g._sel = g.list.every(function (d) { return d._sel !== false; });
          break;
        }
      }
    } else if (type === 'value') {
      for (var i = 0; i < capturedDictValues.length; i++) {
        var g2 = capturedDictValues[i];
        if (g2.dictTypeId === gid) {
          for (var j = 0; j < g2.values.length; j++) {
            if (String(g2.values[j].id) === id) { g2.values[j]._sel = !g2.values[j]._sel; break; }
          }
          g2._sel = g2.values.every(function (v) { return v._sel !== false; });
          break;
        }
      }
    }
    saveStoredData();
    refreshPanel();
  }

  function renderList() {
    var listEl = document.getElementById('ds-list');
    if (!listEl) return;

    var html = '';
    var hasData = false;

    // ── 树形结构：字典类型 → 字典值 ──
    capturedDictTypes.forEach(function (g, gi) {
      var gid = g.dictType || ('__type_' + gi);

      // 收集该组下所有字典值的 _sel 状态
      var allRelValues = [];
      g.list.forEach(function (d) {
        var vg = findValueGroup(d.id);
        if (vg) { allRelValues.push.apply(allRelValues, vg.values); }
      });

      var allTypeSel = g.list.every(function (d) { return d._sel !== false; });
      var allValSel = allRelValues.length > 0 ? allRelValues.every(function (v) { return v._sel !== false; }) : true;
      var allSel = allTypeSel && allValSel;
      var someSel = (!allSel) && (
        g.list.some(function (d) { return d._sel !== false; }) ||
        allRelValues.some(function (v) { return v._sel !== false; })
      );
      var expanded = expandedGroups[gid] !== false;
      var valCount = allRelValues.length;

      html += '<div class="ds-group">';
      html += '<div class="ds-group-hdr ds-tree-parent" style="display:flex;align-items:center;gap:4px">';
      html += '<span class="ds-group-expand" data-gid="' + gid + '" style="cursor:pointer;width:14px;text-align:center">' + (expanded ? '▼' : '▶') + '</span>';
      var cbClass = 'ds-item-cb' + (allSel ? '' : (someSel ? ' ds-partial' : ''));
      html += '<input type="checkbox" class="' + cbClass + '" data-type="type-group" data-gid="' + gid + '" ' + (allSel ? 'checked' : '') + ' style="margin:0 2px">';
      html += '<span style="font-weight:600;font-size:12px">📘 ' + escHtml(g.dictType || '未知') + '</span>';
      html += '<span style="color:#999;font-size:10px;margin-left:auto">' + g.list.length + '类型 ' + (valCount > 0 ? valCount + '值' : '') + '</span>';
      html += '</div>';

      if (expanded) {
        html += '<div class="ds-group-items">';
        // 每个字典实例
        g.list.forEach(function (d) {
          var dgid = 'titem_' + d.id;
          var vg = findValueGroup(d.id);
          var childValues = vg ? vg.values : [];
          var dExpanded = expandedGroups[dgid] !== false;

          html += '<div class="ds-tree-child">';
          html += '<div style="display:flex;align-items:center;gap:4px;padding:2px 0 2px 18px">';
          if (childValues.length > 0) {
            html += '<span class="ds-group-expand" data-gid="' + dgid + '" style="cursor:pointer;width:14px;text-align:center;font-size:10px;color:#999">' + (dExpanded ? '▼' : '▶') + '</span>';
          } else {
            html += '<span style="width:14px"></span>';
          }
          html += '<input type="checkbox" class="ds-item-cb" data-type="type" data-gid="' + gid + '" data-id="' + d.id + '" ' + (d._sel !== false ? 'checked' : '') + ' style="margin:0 2px">';
          html += '<span style="font-size:11px">' + escHtml(d.dictName || d.dictType || '') + '</span>';
          html += '<span style="color:#aaa;font-size:9px;margin-left:4px">ID:' + d.id + '</span>';
          if (childValues.length > 0) {
            html += '<span style="color:#52c41a;font-size:10px;margin-left:auto">' + childValues.length + '值</span>';
          }
          html += '</div>';

          // 字典值子节点
          if (dExpanded && childValues.length > 0) {
            html += '<div style="padding-left:32px">';
            childValues.forEach(function (v) {
              html += '<div class="ds-item" style="padding:1px 0">';
              html += '<input type="checkbox" class="ds-item-cb" data-type="value" data-gid="' + escapeAttr(vg.dictTypeId) + '" data-id="' + v.id + '" ' + (v._sel !== false ? 'checked' : '') + ' style="margin:0 4px">';
              html += '<span style="font-size:11px">📗 ' + escHtml(v.dictLabel || '') + '</span>';
              html += '<span style="color:#aaa;font-size:9px;margin-left:4px">' + escHtml(String(v.dictValue || '')).substring(0, 20) + '</span>';
              html += '</div>';
            });
            html += '</div>';
          }
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</div>';
      hasData = true;
    });

    // ── 未关联字典类型的孤立值 ──
    var orphanValues = [];
    capturedDictValues.forEach(function (vg) {
      var found = false;
      for (var gi = 0; gi < capturedDictTypes.length; gi++) {
        var g = capturedDictTypes[gi];
        for (var di = 0; di < g.list.length; di++) {
          if (String(g.list[di].id) === String(vg.dictTypeId)) { found = true; break; }
        }
        if (found) break;
      }
      if (!found) { orphanValues.push(vg); }
    });

    if (orphanValues.length > 0) {
      html += '<div style="border-top:2px dashed #eee;margin:8px 0;padding-top:4px"></div>';
      html += '<div style="font-size:11px;color:#999;padding:4px 10px">📦 未关联字典的值</div>';
      orphanValues.forEach(function (g, vi) {
        var ogid = '__orphan_' + vi;
        var allSel = g.values.every(function (v) { return v._sel !== false; });
        var someSel = g.values.some(function (v) { return v._sel !== false; });
        var expanded = expandedGroups[ogid] !== false;

        html += '<div class="ds-group">';
        html += '<div class="ds-group-hdr" style="display:flex;align-items:center;gap:4px">';
        html += '<span class="ds-group-expand" data-gid="' + ogid + '" style="cursor:pointer;width:14px;text-align:center">' + (expanded ? '▼' : '▶') + '</span>';
        var oCbClass = 'ds-item-cb' + (allSel ? '' : (someSel ? ' ds-partial' : ''));
        html += '<input type="checkbox" class="' + oCbClass + '" data-type="value-group" data-gid="' + ogid + '" ' + (allSel ? 'checked' : '') + ' style="margin:0 2px">';
        html += '<span style="font-weight:600;font-size:11px">📗 ' + escHtml(g.dictType || g.dictName || g.dictTypeId) + '</span>';
        html += '<span style="color:#999;font-size:10px;margin-left:auto">' + g.values.length + '条</span>';
        html += '</div>';
        if (expanded) {
          html += '<div class="ds-group-items">';
          g.values.forEach(function (v) {
            html += '<div class="ds-item" style="padding-left:26px">';
            html += '<input type="checkbox" class="ds-item-cb" data-type="value" data-gid="' + ogid + '" data-id="' + v.id + '" ' + (v._sel !== false ? 'checked' : '') + ' style="margin:0 4px">';
            html += '<span class="ds-item-label">' + escHtml(v.dictLabel || '') + '</span>';
            html += '<span style="color:#999;font-size:10px;margin-left:4px">' + escHtml(String(v.dictValue || '')).substring(0, 20) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
        hasData = true;
      });
    }

    if (!hasData) {
      html = '<div style="text-align:center;color:#bbb;padding:20px;font-size:12px">暂无数据<br><span style="font-size:11px">在字典页面搜索后点击「一键采集」</span></div>';
    }

    listEl.innerHTML = html;
  }

  /**
   * 根据 dictType.id 查找对应的字典值组
   */
  function findValueGroup(dictTypeId) {
    var sid = String(dictTypeId);
    for (var i = 0; i < capturedDictValues.length; i++) {
      if (String(capturedDictValues[i].dictTypeId) === sid) return capturedDictValues[i];
    }
    return null;
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function refreshPanel() {
    if (!panelEl) return;

    var body = document.getElementById('ds-body');
    if (body) body.style.display = isPanelOpen ? 'block' : 'none';

    // Badge
    var badge = document.getElementById('ds-badge');
    var total = countTypes() + countValues();
    if (badge) {
      if (total > 0) { badge.style.display = 'flex'; badge.textContent = total; }
      else { badge.style.display = 'none'; }
    }

    // 计数
    var tc = document.getElementById('ds-type-cnt');
    var vc = document.getElementById('ds-val-cnt');
    if (tc) tc.textContent = countTypes();
    if (vc) vc.textContent = countValues();

    // 全选框
    var sa = document.getElementById('ds-select-all');
    if (sa) {
      var selCount = countSelectedTypes() + countSelectedValues();
      sa.checked = selCount === total && total > 0;
      sa.indeterminate = selCount > 0 && selCount < total;
    }

    // 列表
    renderList();

    // ── 环境闸：环境徽标 / 只读徽标 / 写入开关 ──
    var host = window.location.hostname;
    var envEl = document.getElementById('ds-env');
    if (envEl) {
      envEl.textContent = EnvGuard.shortEnv(host);
      envEl.title = host + '（' + EnvGuard.envLabel(host) + '环境）';
    }
    var lockEl = document.getElementById('ds-write-lock');
    var togEl = document.getElementById('ds-write-toggle');
    var overrideOn = (_writeOverrideHost === host);
    var whiteListed = EnvGuard.isWriteAllowed(host);
    if (lockEl) {
      if (whiteListed) { lockEl.style.display = 'none'; }
      else if (overrideOn) { lockEl.style.display = ''; lockEl.textContent = '\u26A0 已开启写入'; }
      else { lockEl.style.display = ''; lockEl.textContent = '\uD83D\uDD12 只读'; }
    }
    if (togEl) {
      // 白名单内的环境不给这个按钮：那里本来就能写，多一个开关只会让人以为
      // "默认是不能写的"，反而增加误操作。
      togEl.style.display = whiteListed ? 'none' : '';
      togEl.textContent = overrideOn ? '恢复只读' : '开启写入';
      togEl.title = overrideOn
        ? '恢复只读（刷新页面也会自动恢复）'
        : ('临时允许写入 ' + host);
    }

    // 同步按钮：只读环境下直接置灰并写明原因。
    // 只在点击时才拦的话，用户看到的是一个点得动、点了却什么都不发生的按钮，
    // 会以为功能坏了，也看不出"需要先开启写入"。
    var syncBtn = document.getElementById('ds-sync-sel');
    if (syncBtn) {
      var stopNow = writeBlockedReason();
      syncBtn.disabled = syncStatus === 'syncing' || !!stopNow;
      syncBtn.title = stopNow || '';
      syncBtn.textContent = syncStatus === 'syncing' ? '⏳'
        : (stopNow ? '\uD83D\uDD12 只读环境，禁止写入' : '📤 同步选中');
    }

    // ── 同步结果条 ──
    var resultEl = document.getElementById('ds-result');
    if (resultEl) {
      if (syncStatus === 'syncing') {
        resultEl.style.display = 'block';
        resultEl.className = 'ds-result-bar ds-result-syncing';
        resultEl.innerHTML = '<span class="dict-sync-spinner"></span> 同步中...';
      } else if (syncStatus === 'done') {
        resultEl.style.display = 'block';
        var hasErr = syncStats.err > 0;
        resultEl.className = 'ds-result-bar ' + (hasErr ? 'ds-result-err' : 'ds-result-ok');
        var rParts = [];
        if (syncStats.ok > 0) rParts.push('✓ ' + syncStats.ok + ' 成功');
        if (syncStats.warn > 0) rParts.push('⚠ ' + syncStats.warn + ' 跳过');
        if (syncStats.err > 0) rParts.push('✗ ' + syncStats.err + ' 失败');
        resultEl.innerHTML = rParts.join(' &nbsp;|&nbsp; ');
        setTimeout(function () {
          if (syncStatus === 'done') { resultEl.style.display = 'none'; syncStatus = 'idle'; refreshPanel(); }
        }, 5000);
      } else if (syncStatus === 'error') {
        resultEl.style.display = 'block';
        resultEl.className = 'ds-result-bar ds-result-err';
        resultEl.innerHTML = '❌ 同步出错，展开日志查看详情';
      } else {
        resultEl.style.display = 'none';
      }
    }

    // ── 日志 ──
    var logWrap = document.getElementById('ds-log-wrap');
    var logEl = document.getElementById('ds-log');
    var logCount = document.getElementById('ds-log-count');
    if (logWrap && logEl) {
      if (syncLog.length > 0) {
        logEl.innerHTML = syncLog.map(function (l) {
          var cls = l.type === 'ok' ? 'success' : l.type === 'skip' ? 'warn' : l.type;
          return '<div class="ds-log-item ds-log-' + cls + '">[' + l.time + '] ' + escHtml(l.msg) + '</div>';
        }).join('');
        if (logCount) logCount.textContent = syncLog.length + ' 条';
        logWrap.style.display = '';
        if (syncStatus === 'done' || syncStatus === 'syncing') logEl.scrollTop = logEl.scrollHeight;
      } else {
        logWrap.style.display = 'none';
      }
    }
  }

  function disableSyncBtn(disabled) {
    var btn = document.getElementById('ds-sync-sel');
    if (!btn) return;
    if (disabled) { btn.disabled = true; btn.textContent = '⏳ 采集中'; return; }
    // 恢复时交回 refreshPanel：这里若直接写死'📤 同步选中'，会把只读环境下的
    // "🔒 只读环境，禁止写入"文案冲掉，出现"文案说能同步、点了却被拦"的矛盾。
    refreshPanel();
  }

  function pulseToggle() {
    var toggle = document.getElementById('ds-toggle');
    if (toggle) { toggle.classList.add('dict-sync-pulse'); setTimeout(function () { toggle.classList.remove('dict-sync-pulse'); }, 1000); }
  }

  // ==================== 拖拽 ====================
  function setupDrag() {
    var toggle = document.getElementById('ds-toggle');
    if (!toggle) return;

    var dragging = false, moved = false;
    var startX, startY, startRight, startBottom;
    var DRAG_THRESHOLD = 3; // 像素阈值，超过才算拖拽

    // 🔑 拖拽时阻止 click 事件
      toggle.addEventListener('click', function (e) {
        if (moved) { e.stopPropagation(); e.preventDefault(); }
      }, true); // 捕获阶段拦截
    try {
      var saved = localStorage.getItem('dict_sync_pos');
      if (saved) {
        var pos = JSON.parse(saved);
        panelEl.style.right = pos.right + 'px';
        panelEl.style.bottom = pos.bottom + 'px';
        panelEl.style.top = 'auto';
        panelEl.style.left = 'auto';
      }
    } catch (e) {}

    toggle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      var rect = panelEl.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      toggle.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var dx = startX - e.clientX;
      var dy = startY - e.clientY;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        moved = true;
      }
      var newRight = Math.max(0, Math.min(startRight + dx, window.innerWidth - 44));
      var newBottom = Math.max(0, Math.min(startBottom + dy, window.innerHeight - 44));
      panelEl.style.right = newRight + 'px';
      panelEl.style.bottom = newBottom + 'px';
      panelEl.style.top = 'auto';
      panelEl.style.left = 'auto';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      toggle.classList.remove('dragging');
      // 保存位置
      try {
        var r = panelEl.style.right;
        var b = panelEl.style.bottom;
        localStorage.setItem('dict_sync_pos', JSON.stringify({
          right: parseInt(r) || 20,
          bottom: parseInt(b) || 20
        }));
      } catch (e) {}
    });
  }

  // ==================== 诊断 ====================
  async function debugStorage() {
    console.group('📋 Dict Sync Diagnostic');
    console.log('Memory types:', capturedDictTypes.length, 'groups,', countTypes(), 'items');
    console.log('Memory values:', capturedDictValues.length, 'groups,', countValues(), 'items');

    try {
      var raw = await chrome.storage.local.get(STORAGE_KEY);
      console.log('Storage:', raw);
      if (raw[STORAGE_KEY]) {
        var s = raw[STORAGE_KEY];
        var st = (s.dictTypes || []).reduce(function (sum, g) { return sum + (g.list ? g.list.length : 0); }, 0);
        var sv = (s.dictValues || []).reduce(function (sum, g) { return sum + (g.values ? g.values.length : 0); }, 0);
        console.log('  types:', (s.dictTypes || []).length, 'groups,', st, 'items');
        console.log('  values:', (s.dictValues || []).length, 'groups,', sv, 'items');
        console.log('  total:', st + sv);
        console.log('  lastUpdated:', s.lastUpdated ? new Date(s.lastUpdated).toLocaleString() : 'never');
        if (st + sv !== countTypes() + countValues()) {
          console.warn('⚠ Memory ≠ Storage! Memory:', countTypes() + countValues(), 'Storage:', st + sv);
        }
      } else {
        console.log('Storage: EMPTY');
      }
    } catch (e) { console.error('Storage read error:', e); }
    console.groupEnd();
    addLog('🔍 诊断已输出到 Console', 'info');
  }

  // ==================== 外部消息 ====================
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'CLEAR_DATA_MEMORY') {
      capturedDictTypes = [];
      capturedDictValues = [];
      syncLog = [];
      syncStatus = 'idle';
      _apiBaseOrigin = null;
      refreshPanel();
      sendResponse({ success: true });
    }
    if (msg.type === 'GET_STATUS') {
      sendResponse({
        dictTypeCount: countTypes(),
        dictValueCount: countValues(),
        syncStatus: syncStatus
      });
    }
    return true;
  });

  // ==================== 启动 ====================
  init();
})();