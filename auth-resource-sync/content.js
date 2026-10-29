/**
 * Auth Resource Sync - Content Script
 * 双树面板 + 同步引擎
 */
(function () {
  'use strict';

  // ==================== 常量 ====================
  var STORAGE_KEY = 'auth_resource_sync_data';
  var INJECT_SCRIPT = chrome.runtime.getURL('inject.js');

  // 节点类型
  var TYPE_DIR = 1;   // 目录
  var TYPE_MENU = 2;  // 菜单
  var TYPE_BTN = 3;   // 按钮
  var TYPE_FIELD = 4; // 字段
  var TYPE_DATA = 5;  // 数据

  var TYPE_ICONS = {};
  TYPE_ICONS[TYPE_DIR] = '\uD83D\uDCC1';   // 📁
  TYPE_ICONS[TYPE_MENU] = '\uD83D\uDCCB';  // 📋
  TYPE_ICONS[TYPE_BTN] = '\uD83D\uDD18';   // 🔘
  TYPE_ICONS[TYPE_FIELD] = '\uD83D\uDCDD'; // 📝
  TYPE_ICONS[TYPE_DATA] = '\uD83D\uDCBE';  // 💾

  var TYPE_NAMES = {};
  TYPE_NAMES[TYPE_DIR] = '目录';
  TYPE_NAMES[TYPE_MENU] = '菜单';
  TYPE_NAMES[TYPE_BTN] = '按钮';
  TYPE_NAMES[TYPE_FIELD] = '字段';
  TYPE_NAMES[TYPE_DATA] = '数据';

  var API_ROUTES = {};
  API_ROUTES['add_1'] = '/auth2/resource/addDirectoryNode';
  API_ROUTES['edit_1'] = '/auth2/resource/editDirectoryNode';
  API_ROUTES['add_2'] = '/auth2/resource/addMenuNode';
  API_ROUTES['edit_2'] = '/auth2/resource/editMenuNode';
  API_ROUTES['add_3'] = '/auth2/resource/addButtonNode';
  API_ROUTES['edit_3'] = '/auth2/resource/editButtonNode';
  API_ROUTES['add_4'] = '/auth2/resource/addFieldNode';
  API_ROUTES['edit_4'] = '/auth2/resource/editFieldNode';
  API_ROUTES['add_5'] = '/auth2/resource/addDataNode';
  API_ROUTES['edit_5'] = '/auth2/resource/editDataNode';

  // ==================== 状态 ====================
  var isPanelOpen = false;
  var panelEl = null;
  var devTree = [];          // dev 完整树（带 _sel 标记）
  var testTree = [];         // test 完整树
  var devAppId = null;
  var testAppId = null;
  var _apiBaseOrigin = null;
  var syncTasks = [];        // 批量同步任务队列: [{sourceNode, sourceChildren, targetParentId, targetParentName}]
  var singleTasks = [];      // 单点更新任务队列: [{sourceNode, targetNodeId, targetNodeName}]
  var syncMode = 'batch';    // 当前模式: 'batch' 批量同步 | 'single' 单点更新
  var selectedTestNodeId = null;  // 目标数据当前选中的目标父节点
  var syncStatus = 'idle';
  var syncLog = [];
  var expandedDev = {};      // 源数据展开状态
  var expandedTest = {};     // 目标数据展开状态
  var expandedQueue = {};    // 队列展开状态
  var devSearchText = '';
  var testSearchText = '';

  // ==================== 初始化 ====================
  var isAuthPage = false;
  var _lastUrl = '';

  function checkAuthPage() {
    var url = window.location.href;
    if (url === _lastUrl) return isAuthPage;
    _lastUrl = url;
    // 匹配权限管理/资源管理页面
    isAuthPage = /\/MF_auth\//.test(url);
    return isAuthPage;
  }

  async function init() {
    checkAuthPage();
    if (!isAuthPage) {
      startUrlWatcher();
      return;
    }

    injectPageScript();
    await loadStoredData();
    window.addEventListener('message', handlePageMessage);
    createFloatingPanel();
    log('[Auth Sync] Init done');
    startUrlWatcher();
  }

  function startUrlWatcher() {
    var lastChecked = window.location.href;
    setInterval(function () {
      var current = window.location.href;
      if (current === lastChecked) return;
      lastChecked = current;
      var was = isAuthPage;
      checkAuthPage();
      if (!was && isAuthPage) {
        if (!panelEl) {
          injectPageScript();
          loadStoredData().then(function () {
            createFloatingPanel();
          });
        }
      } else if (was && !isAuthPage) {
        if (panelEl) {
          panelEl.remove();
          panelEl = null;
          isPanelOpen = false;
        }
      }
    }, 800);
  }

  function injectPageScript() {
    if (document.getElementById('auth-resource-sync-inject')) return;
    var script = document.createElement('script');
    script.id = 'auth-resource-sync-inject';
    script.src = INJECT_SCRIPT;
    script.onload = function () { script.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  function handlePageMessage(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'auth-resource-sync-inject') return;
    if (event.data.type === 'RESOURCE_TREE_CAPTURED') {
      pulseToggle();
    }
  }

  // ==================== 存储 ====================
  async function loadStoredData() {
    try {
      var result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        var d = result[STORAGE_KEY];
        devTree = d.devTree || [];
        testTree = d.testTree || [];
        devAppId = d.devAppId || null;
        testAppId = d.testAppId || null;
        syncTasks = d.syncTasks || [];
        singleTasks = d.singleTasks || [];
        syncMode = d.syncMode || 'batch';
        srcSnapshot = d.srcSnapshot || null;
        tgtSnapshot = d.tgtSnapshot || null;
        log('[Auth Sync] Loaded: dev ' + countNodes(devTree) + ' nodes, test ' + countNodes(testTree) + ' nodes');
        return true;
      }
      return false;
    } catch (e) {
      console.error('[Auth Sync] Load error:', e);
      return false;
    }
  }

  async function saveStoredData() {
    try {
      var obj = {};
      obj[STORAGE_KEY] = {
        devTree: devTree,
        testTree: testTree,
        devAppId: devAppId,
        testAppId: testAppId,
        syncTasks: syncTasks,
        singleTasks: singleTasks,
        syncMode: syncMode,
        srcSnapshot: srcSnapshot,
        tgtSnapshot: tgtSnapshot,
        lastUpdated: Date.now()
      };
      await chrome.storage.local.set(obj);
    } catch (e) {
      console.error('[Auth Sync] Save error:', e);
    }
  }

  async function clearAllData() {
    devTree = [];
    testTree = [];
    devAppId = null;
    testAppId = null;
    syncTasks = [];
    singleTasks = [];
    syncMode = 'batch';
    srcSnapshot = null;
    tgtSnapshot = null;
    _userPlan = null;
    syncLog = [];
    selectedTestNodeId = null;
    syncStatus = 'idle';
    try { await chrome.storage.local.remove(STORAGE_KEY); } catch (e) {}
  }

  chrome.storage.onChanged.addListener(function (changes, namespace) {
    if (namespace !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    var newVal = changes[STORAGE_KEY].newValue;
    if (!newVal) return;
    devTree = newVal.devTree || [];
    testTree = newVal.testTree || [];
    devAppId = newVal.devAppId;
    testAppId = newVal.testAppId;
    syncTasks = newVal.syncTasks || [];
    singleTasks = newVal.singleTasks || [];
    syncMode = newVal.syncMode || 'batch';
    srcSnapshot = newVal.srcSnapshot || null;
    tgtSnapshot = newVal.tgtSnapshot || null;
    refreshPanel();
  });

  // ==================== 与 inject.js 通信 ====================
  var _reqIdCounter = 0;
  function nextReqId() { return 'req_' + (++_reqIdCounter) + '_' + Date.now(); }

  function sendToInject(msg) {
    return new Promise(function (resolve, reject) {
      var requestId = nextReqId();
      msg.requestId = requestId;
      msg.source = 'auth-resource-sync-content';
      var timeout = setTimeout(function () {
        window.removeEventListener('message', handler);
        reject(new Error('Timeout: ' + msg.type));
      }, 20000);

      function handler(event) {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'auth-resource-sync-inject') return;
        if (event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
      window.addEventListener('message', handler);
      window.postMessage(msg, '*');
    });
  }

  function getToken() {
    var t = localStorage.getItem('Admin-Token');
    return t ? 'Bearer ' + t : '';
  }

  async function getApiBaseOrigin() {
    if (_apiBaseOrigin) return _apiBaseOrigin;

    // 1. 最权威的来源：inject.js 拦截到的真实 /auth2 请求地址。
    //    比按域名猜可靠，也是唯一能覆盖 xxx-auth.joyintoy.cn 这类命名的方式。
    try {
      var cachedResp = await sendToInject({ type: 'GET_CACHED_DATA' });
      var p = cachedResp && cachedResp.payload;
      if (p && p.auth2Origin) {
        _apiBaseOrigin = p.auth2Origin;
        log('[Auth Sync] API origin from intercepted request: ' + _apiBaseOrigin);
        return _apiBaseOrigin;
      }
      if (p && p.resourceTree && p.resourceTree.url) {
        var url = p.resourceTree.url;
        // URL 可能是相对路径 '/auth2/...' 或完整 URL
        if (url.indexOf('http') === 0) {
          _apiBaseOrigin = new URL(url).origin;
          log('[Auth Sync] API origin from cache: ' + _apiBaseOrigin);
          return _apiBaseOrigin;
        }
      }
    } catch (e) {}

    // 2. 兜底：按域名约定推断。
    //    约定是「前端 <env>[-auth].joyintoy.cn -> 后端 <env>-api.joyintoy.cn」。
    //    ⚠️ 必须先把首段末尾的 -auth 去掉：实测 mdmdev-auth.joyintoy.cn 的后端是
    //    mdmdev-api.joyintoy.cn，而旧写法会推成 mdmdev-auth-api.joyintoy.cn（该域名不存在），
    //    导致整个扩展在这个环境上不可用。
    var host = window.location.hostname;
    if (host.indexOf('localhost') !== -1 || host === '127.0.0.1') {
      // 本地开发可能直接配了代理，用当前 origin
      _apiBaseOrigin = window.location.origin;
    } else {
      var parts = host.split('.');
      if (parts.length >= 3) {
        parts[0] = parts[0].replace(/-auth$/, '') + '-api';
        _apiBaseOrigin = 'https://' + parts.join('.');
      } else {
        _apiBaseOrigin = window.location.origin;
      }
    }

    log('[Auth Sync] API origin inferred: ' + _apiBaseOrigin);
    return _apiBaseOrigin;
  }

  async function fetchTreeFromPage() {
    var apiBase = await getApiBaseOrigin();
    // 从页面中尝试获取 appId
    var appId = await detectAppIdFromPage();

    if (!appId) {
      addLog('\u26A0 无法检测到 appId，请确保已打开应用的权限管理页面', 'warn');
      return null;
    }

    try {
      var resp = await sendToInject({
        type: 'FETCH_RESOURCE_TREE',
        apiBase: apiBase,
        appId: appId,
        token: getToken()
      });

      if (resp.success && resp.payload) {
        return {
          tree: resp.payload.data || [],
          appId: appId
        };
      }
      // 更详细的错误信息
      var errDetail = '';
      if (resp.data && resp.data.code) {
        errDetail = ' [code=' + resp.data.code + (resp.data.msg ? ' msg=' + resp.data.msg : '') + ']';
      } else if (resp.error) {
        errDetail = ' [' + resp.error + ']';
      }
      addLog('\u2717 获取资源树失败' + errDetail + ' (apiBase=' + apiBase + ' appId=' + appId + ')', 'error');
      return null;
    } catch (e) {
      addLog('\u2717 获取资源树异常: ' + e.message, 'error');
      return null;
    }
  }

  async function detectAppIdFromPage() {
    // 1. 检查手动输入
    var manualInput = document.getElementById('as-appid-input');
    if (manualInput && manualInput.value && manualInput.value.trim()) {
      var manual = parseInt(manualInput.value.trim(), 10);
      if (manual > 0) return manual;
    }

    // 2. 尝试从 URL 参数获取
    var url = window.location.href;
    var match = url.match(/[?&]appId=(\d+)/);
    if (match) return parseInt(match[1], 10);

    // 3. 尝试从 history state 获取
    if (window.history.state && window.history.state.appId) {
      return window.history.state.appId;
    }

    // 4. 尝试从 inject.js 缓存的 XHR 拦截数据中获取
    try {
      var cachedResp = await sendToInject({ type: 'GET_CACHED_DATA' });
      if (cachedResp && cachedResp.payload && cachedResp.payload.resourceTree && cachedResp.payload.resourceTree.appId) {
        return cachedResp.payload.resourceTree.appId;
      }
    } catch (e) {}

    return null;
  }

  // ==================== 采集 ====================
  async function captureCurrentTree(env) {
    disableButtons(true);
    var isSource = env === '\u6E90';
    var label = isSource ? '\u6E90\u6570\u636E' : '\u76EE\u6807\u6570\u636E';
    try {
      addLog('\uD83D\uDCE5 \u6B63\u5728\u91C7\u96C6 ' + label + '...', 'info');
      var result = await fetchTreeFromPage();

      if (!result) {
        addLog('\u26A0 ' + label + ' \u91C7\u96C6\u5931\u8D25', 'warn');
        return;
      }

      addSelectionFlags(result.tree);

      if (isSource) {
        devTree = result.tree;
        devAppId = result.appId;
        addLog('\u2705 ' + label + '\u5DF2\u91C7\u96C6: ' + countNodes(devTree) + ' \u4E2A\u8282\u70B9, appId=' + devAppId, 'success');
      } else {
        testTree = result.tree;
        testAppId = result.appId;
        addLog('\u2705 ' + label + '\u5DF2\u91C7\u96C6: ' + countNodes(testTree) + ' \u4E2A\u8282\u70B9, appId=' + testAppId, 'success');
      }

      await saveStoredData();
      refreshPanel();
    } catch (e) {
      addLog('\u2717 采集异常: ' + e.message, 'error');
    } finally {
      disableButtons(false);
      refreshPanel();
    }
  }

  function addSelectionFlags(nodes) {
    if (!nodes) return;
    nodes.forEach(function (n) {
      n._sel = false;
      if (n.children && n.children.length > 0) {
        addSelectionFlags(n.children);
      }
      if (n.resourceDetailList && n.resourceDetailList.length > 0) {
        n.resourceDetailList.forEach(function (d) { d._sel = false; });
      }
    });
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

  // ==================== 树操作 ====================
  function findNodeById(nodes, id) {
    for (var i = 0; i < nodes.length; i++) {
      if (String(nodes[i].id) === String(id)) return nodes[i];
      if (nodes[i].children) {
        var found = findNodeById(nodes[i].children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function getNodePath(nodes, targetId, path) {
    path = path || [];
    for (var i = 0; i < nodes.length; i++) {
      if (String(nodes[i].id) === String(targetId)) {
        path.push(nodes[i].name || nodes[i].code || '');
        return path;
      }
      if (nodes[i].children) {
        var result = getNodePath(nodes[i].children, targetId, path.concat([nodes[i].name || nodes[i].code || '']));
        if (result) return result;
      }
    }
    return null;
  }

  function flattenTree(nodes, result) {
    result = result || [];
    nodes.forEach(function (n) {
      result.push(n);
      if (n.children) flattenTree(n.children, result);
    });
    return result;
  }

  // 获取勾选节点的根节点列表（去除被勾选祖先包含的子孙）
  function getSelectedRoots() {
    var allSelected = [];
    function collect(nodes) {
      nodes.forEach(function (n) {
        if (n._sel) allSelected.push(n);
        if (n.children) collect(n.children);
      });
    }
    collect(devTree);

    // 过滤：如果某个节点的祖先也被勾选了，去掉它
    var selectedIds = {};
    allSelected.forEach(function (n) { selectedIds[String(n.id)] = true; });

    return allSelected.filter(function (n) {
      // 检查祖先是否也被勾选
      if (n._parentIdArr) {
        for (var i = 0; i < n._parentIdArr.length; i++) {
          if (selectedIds[String(n._parentIdArr[i])]) return false;
        }
      }
      return true;
    });
  }

  // 为所有节点添加 parentIdArr（祖先 id 数组）
  function addParentIdArr(nodes, parentArr) {
    parentArr = parentArr || [];
    nodes.forEach(function (n) {
      n._parentIdArr = parentArr.slice();
      if (n.children && n.children.length > 0) {
        addParentIdArr(n.children, parentArr.concat([n.id]));
      }
      if (n.resourceDetailList && n.resourceDetailList.length > 0) {
        n.resourceDetailList.forEach(function (d) {
          d._parentIdArr = parentArr.concat([n.id]);
        });
      }
    });
  }

  // 递归设置节点及其所有子孙的 _sel 状态
  function setNodeSelRecursive(node, val) {
    node._sel = val;
    if (node.children) {
      node.children.forEach(function (c) { setNodeSelRecursive(c, val); });
    }
    if (node.resourceDetailList) {
      node.resourceDetailList.forEach(function (d) { d._sel = val; });
    }
  }

  // 计算节点的半选状态（部分子孙选中）
  function getNodeCheckedState(node) {
    if (!node.children || node.children.length === 0) {
      return node._sel ? 'checked' : 'unchecked';
    }
    var allChecked = true;
    var anyChecked = false;
    function check(n) {
      if (n._sel) anyChecked = true;
      else allChecked = false;
      if (n.children) n.children.forEach(check);
    }
    node.children.forEach(check);
    if (allChecked) return 'checked';
    if (anyChecked) return 'indeterminate';
    return 'unchecked';
  }

  // ==================== 勾选交互 ====================
  function toggleDevNode(node) {
    if (syncMode === 'single') {
      // 单点模式：单选，清除其他节点
      clearSelectionFlags(devTree);
      node._sel = true;
    } else {
      var newVal = !node._sel;
      setNodeSelRecursive(node, newVal);
      updateAncestorSel(devTree, node);
    }
    saveStoredData();
    refreshPanel();
  }

  function clearSelectionFlags(nodes) {
    nodes.forEach(function (n) {
      n._sel = false;
      if (n.children) clearSelectionFlags(n.children);
      if (n.resourceDetailList) n.resourceDetailList.forEach(function (d) { d._sel = false; });
    });
  }

  function updateAncestorSel(nodes, target) {
    if (!target._parentIdArr || target._parentIdArr.length === 0) return;
    function recalc(n) {
      if (n.children && n.children.length > 0) {
        var state = getNodeCheckedState(n);
        n._sel = (state === 'checked');
        n.children.forEach(recalc);
      }
    }
    nodes.forEach(recalc);
  }

  // 递归设置展开状态
  function setAllExpanded(nodes, map, val) {
    nodes.forEach(function (n) {
      map[String(n.id)] = val;
      if (n.children && n.children.length > 0) setAllExpanded(n.children, map, val);
    });
  }

  // 全选/取消全选 dev 树
  function toggleSelectAllDev() {
    var allSel = true;
    function check(nodes) {
      nodes.forEach(function (n) {
        if (!n._sel) allSel = false;
        if (n.children) check(n.children);
      });
    }
    check(devTree);
    var newVal = !allSel;
    function apply(nodes) {
      nodes.forEach(function (n) {
        n._sel = newVal;
        if (n.children) apply(n.children);
      });
    }
    apply(devTree);
    saveStoredData();
    refreshPanel();
  }

  // 搜索时自动展开匹配节点的父级路径
  function autoExpandSearch(nodes, map, search) {
    function expand(n) {
      var selfMatch = nodeMatchesSearch(n, search);
      var childMatch = false;
      if (n.children) {
        n.children.forEach(function (c) {
          if (expand(c)) childMatch = true;
        });
      }
      if (selfMatch || childMatch) {
        map[String(n.id)] = true;
        return true;
      }
      return false;
    }
    nodes.forEach(expand);
  }

  // ==================== 任务队列 ====================
  function addToQueue() {
    var roots = getSelectedRoots();
    if (roots.length === 0) {
      addLog('\u26A0 请先在 源数据中勾选要同步的节点', 'warn');
      return;
    }
    if (!selectedTestNodeId) {
      addLog('\u26A0 请在 目标数据中点击选择目标父节点', 'warn');
      return;
    }

    var targetNode = findNodeById(testTree, selectedTestNodeId);
    if (!targetNode) {
      addLog('\u26A0 目标节点不存在', 'warn');
      return;
    }

    // 只允许挂到 type 1/2 节点下
    if (targetNode.type !== TYPE_DIR && targetNode.type !== TYPE_MENU) {
      addLog('\u26A0 只能挂到目录或菜单节点下', 'warn');
      return;
    }

    var added = 0;
    roots.forEach(function (root) {
      // 收集该根节点下的所有子孙节点
      var allChildren = [];
      function collect(n) {
        if (n.children) {
          n.children.forEach(function (c) {
            if (c._sel) {
              allChildren.push(c);
              collect(c);
            }
          });
        }
      }
      collect(root);

      // 检查是否重复
      var dup = syncTasks.some(function (t) {
        return String(t.sourceNode.id) === String(root.id) && String(t.targetParentId) === String(targetNode.id);
      });
      if (!dup) {
        syncTasks.push({
          sourceNode: root,
          sourceChildren: allChildren,
          targetParentId: targetNode.id,
          targetParentName: targetNode.name
        });
        added++;
      }
    });

    addLog('\u2795 已加入 ' + added + ' 条同步任务到队列', 'success');
    saveStoredData();
    refreshPanel();
  }

  function removeTask(index) {
    var removed = syncTasks.splice(index, 1);
    if (removed.length > 0) {
      addLog('\uD83D\uDDD1 已移除: ' + removed[0].sourceNode.name, 'info');
    }
    saveStoredData();
    refreshPanel();
  }

  function clearQueue() {
    if (syncTasks.length === 0) return;
    syncTasks = [];
    addLog('\uD83D\uDDD1 已清空批量队列', 'info');
    saveStoredData();
    refreshPanel();
  }

  // ==================== 模式切换 ====================
  function switchMode(mode) {
    syncMode = mode;
    // 清空已选的源数据节点和目标数据节点
    clearSelectionFlags(devTree);
    selectedTestNodeId = null;
    // 更新模式 tab 高亮
    var batchBtn = document.getElementById('as-mode-batch');
    var singleBtn = document.getElementById('as-mode-single');
    if (batchBtn) batchBtn.classList.toggle('as-mode-active', mode === 'batch');
    if (singleBtn) singleBtn.classList.toggle('as-mode-active', mode === 'single');
    if (mode === 'single') {
      var addBtn = document.getElementById('as-add-queue');
      var updBtn = document.getElementById('as-update-single');
      if (addBtn) addBtn.style.display = 'none';
      if (updBtn) updBtn.style.display = '';
    } else {
      var addBtn2 = document.getElementById('as-add-queue');
      var updBtn2 = document.getElementById('as-update-single');
      if (addBtn2) addBtn2.style.display = '';
      if (updBtn2) updBtn2.style.display = 'none';
    }
    saveStoredData();
    refreshPanel();
  }

  // ==================== 单点更新 ====================
  function addSingleUpdate() {
    var roots = getSelectedRoots();
    if (roots.length !== 1) {
      addLog('\u26A0 \u5355\u70B9\u66F4\u65B0\u8BF7\u53EA\u52FE\u9009\u4E00\u4E2A\u8282\u70B9', 'warn');
      return;
    }
    if (!selectedTestNodeId) {
      addLog('\u26A0 \u8BF7\u5728\u76EE\u6807\u6570\u636E\u4E2D\u70B9\u51FB\u9009\u62E9\u76EE\u6807\u8282\u70B9', 'warn');
      return;
    }
    var source = roots[0];
    var target = findNodeById(testTree, selectedTestNodeId);
    if (!target) {
      addLog('\u26A0 \u76EE\u6807\u8282\u70B9\u4E0D\u5B58\u5728', 'warn');
      return;
    }
    if (source.type !== target.type) {
      addLog('\u26A0 \u6E90\u4E0E\u76EE\u6807\u8282\u70B9\u7C7B\u578B\u4E0D\u4E00\u81F4 (' + TYPE_NAMES[source.type] + ' \u2260 ' + TYPE_NAMES[target.type] + ')', 'warn');
      return;
    }

    var dup = singleTasks.some(function (t) {
      return String(t.sourceNode.id) === String(source.id) && String(t.targetNodeId) === String(target.id);
    });
    if (!dup) {
      singleTasks.push({ sourceNode: source, targetNodeId: target.id, targetNodeName: target.name });
      addLog('\uD83C\uDFAF \u5DF2\u52A0\u5165\u5355\u70B9\u66F4\u65B0: ' + source.name + ' \u2192 ' + target.name, 'success');
      saveStoredData();
      refreshPanel();
    } else {
      addLog('\u26A0 \u8BE5\u5355\u70B9\u66F4\u65B0\u5DF2\u5B58\u5728', 'warn');
    }
  }

  function clearSingleQueue() {
    if (singleTasks.length === 0) return;
    singleTasks = [];
    addLog('\uD83D\uDDD1 \u5DF2\u6E05\u7A7A\u5355\u70B9\u961F\u5217', 'info');
    saveStoredData();
    refreshPanel();
  }

  async function executeSingleUpdates() {
    if (syncStatus === 'syncing') { addLog('\u26A0 \u540C\u6B65\u4E2D...', 'warn'); return; }
    if (singleTasks.length === 0) { addLog('\u26A0 \u5355\u70B9\u961F\u5217\u4E3A\u7A7A', 'warn'); return; }

    syncStatus = 'syncing';
    syncLog = [];
    refreshPanel();

    var apiBase = await getApiBaseOrigin();
    var token = getToken();
    var ok = 0, err = 0, detail = 0;

    addLog('\uD83C\uDFAF \u5F00\u59CB\u5355\u70B9\u66F4\u65B0 ' + singleTasks.length + ' \u6761...', 'info');

    for (var i = 0; i < singleTasks.length; i++) {
      var t = singleTasks[i];
      var src = t.sourceNode;
      var tgtId = t.targetNodeId;
      var label = src.name + ' [' + TYPE_NAMES[src.type] + '] \u2192 id=' + tgtId;

      // 用源节点字段 + 目标父节点（保持目标节点原父位置）构造 payload
      var payload = buildNodePayload(src, src.parentId || 0);
      payload.id = tgtId;

      try {
        var apiPath = API_ROUTES['edit_' + src.type];
        var apiResp = await sendToInject({ type: 'CALL_API', apiPath: apiBase + apiPath, data: payload, token: token });
        if (apiResp.success && apiResp.data && apiResp.data.code === 200) {
          ok++;
          // 字段/数据节点：明细一起覆盖
          if ((src.type === TYPE_FIELD || src.type === TYPE_DATA) && src.resourceDetailList && src.resourceDetailList.length > 0) {
            var detailPayload = {
              itemList: src.resourceDetailList.map(function (d, idx) {
                return { name: d.name || '', code: d.code || '', isPublicFieldBoolean: d.isPublicFieldBoolean || false, orderNum: idx + 1, appId: testAppId, resourceId: String(tgtId) };
              }),
              resourceId: String(tgtId)
            };
            var batchResp = await sendToInject({ type: 'CALL_API', apiPath: apiBase + '/auth2/resource/batchAddDetail', data: detailPayload, token: token });
            if (batchResp.success && batchResp.data && batchResp.data.code === 200) detail += src.resourceDetailList.length;
          }
        } else {
          err++;
          addLog('  \u2717 ' + label + ' ' + (apiResp.data ? apiResp.data.msg || ('code=' + apiResp.data.code) : '\u672A\u77E5'), 'error');
        }
      } catch (e) {
        err++;
        addLog('  \u2717 ' + label + ' ' + e.message, 'error');
      }
      await sleep(150);
      refreshPanel();
    }

    addLog('\u2705 \u5355\u70B9\u66F4\u65B0\u5B8C\u6210: \u2713' + ok + (detail > 0 ? ' +' + detail + '\u660E\u7EC6' : '') + (err > 0 ? ' \u2717' + err : ''), err > 0 ? 'warn' : 'success');

    singleTasks = [];
    syncStatus = 'done';
    await saveStoredData();

    addLog('\uD83D\uDD04 \u91CD\u65B0\u91C7\u96C6\u76EE\u6807\u6570\u636E...', 'info');
    await captureCurrentTree('\u76EE\u6807');

    syncStatus = 'idle';
    refreshPanel();
  }

  // ==================== 同步引擎 ====================
  // 在目标树中查找匹配节点
  function findInTarget(parentId, node) {
    if (!testTree || testTree.length === 0) return null;
    var key;
    if (node.type === TYPE_BTN) key = node.perms;
    else if (node.type === TYPE_FIELD || node.type === TYPE_DATA) key = node.code;
    else if (node.type === TYPE_MENU && node.path) key = node.path;
    else key = node.name;
    if (!key) return null;

    function search(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (String(n.parentId) === String(parentId) && n.type === node.type) {
          var nKey;
          if (n.type === TYPE_BTN) nKey = n.perms;
          else if (n.type === TYPE_FIELD || n.type === TYPE_DATA) nKey = n.code;
          else if (n.type === TYPE_MENU && n.path) nKey = n.path;
          else nKey = n.name;
          if (nKey && nKey === key) return n;
        }
        if (n.children) {
          var found = search(n.children);
          if (found) return found;
        }
      }
      return null;
    }
    return search(testTree);
  }

  // 判断目标节点与源节点字段是否一致（一致则无需更新）
  function nodesEqual(targetNode, sourceNode) {
    var fields = ['name', 'orderNum', 'status', 'perms', 'code', 'pageKey'];
    if (sourceNode.type === TYPE_DIR || sourceNode.type === TYPE_MENU) {
      fields = fields.concat(['iconCode', 'path', 'component', 'visible', 'isFrame']);
    }
    if (sourceNode.type === TYPE_MENU) {
      fields = fields.concat(['query', 'isCache']);
    }
    if (sourceNode.type === TYPE_FIELD) {
      fields = fields.concat(['displayType']);
    }
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var a = targetNode[f] === undefined || targetNode[f] === null ? '' : targetNode[f];
      var b = sourceNode[f] === undefined || sourceNode[f] === null ? '' : sourceNode[f];
      if (String(a) !== String(b)) return false;
    }
    // 字段/数据节点：对比明细列表
    if (sourceNode.type === TYPE_FIELD || sourceNode.type === TYPE_DATA) {
      var sDetails = sourceNode.resourceDetailList || [];
      var tDetails = targetNode.resourceDetailList || [];
      if (sDetails.length !== tDetails.length) return false;
      for (var j = 0; j < sDetails.length; j++) {
        if (String(sDetails[j].name||'') !== String(tDetails[j].name||'')) return false;
        if (String(sDetails[j].code||'') !== String(tDetails[j].code||'')) return false;
        if (String(sDetails[j].isPublicFieldBoolean) !== String(tDetails[j].isPublicFieldBoolean)) return false;
      }
    }
    return true;
  }

  async function executeSync() {
    if (syncStatus === 'syncing') { addLog('\u26A0 同步中...', 'warn'); return; }
    if (syncTasks.length === 0) { addLog('\u26A0 同步队列为空', 'warn'); return; }

    syncStatus = 'syncing';
    syncLog = [];
    refreshPanel();

    var apiBase = await getApiBaseOrigin();
    var token = getToken();

    addLog('\uD83D\uDE80 \u5F00\u59CB\u540C\u6B65 ' + syncTasks.length + ' \u6761\u4EFB\u52A1...', 'info');

    for (var ti = 0; ti < syncTasks.length; ti++) {
      var task = syncTasks[ti];
      var source = task.sourceNode;
      var targetId = task.targetParentId;
      var targetName = task.targetParentName;

      var bfsQueue = [source];
      var idMap = {};
      var taskOk = 0, taskErr = 0, taskUpdated = 0, taskDetailTotal = 0;

      for (var bi = 0; bi < bfsQueue.length; bi++) {
        var node = bfsQueue[bi];
        var label = node.name + ' [' + TYPE_NAMES[node.type] + ']';

        var parentId;
        if (String(node.id) === String(source.id)) {
          parentId = targetId;
        } else {
          parentId = idMap[String(node._parentId || node.parentId)] || targetId;
        }

        // 在目标树中搜索是否已存在
        var existing = findInTarget(parentId, node);
        var isUpdate = !!existing;
        // 字段一致 → 跳过，不发请求
        if (isUpdate && nodesEqual(existing, node)) {
          idMap[String(node.id)] = existing.id;
        } else {
          var payload = buildNodePayload(node, parentId);
          if (isUpdate) payload.id = existing.id;

          try {
            var apiPath = (isUpdate ? API_ROUTES['edit_' + node.type] : API_ROUTES['add_' + node.type]);
            var fullPath = apiBase + apiPath;

            var apiResp = await sendToInject({
              type: 'CALL_API',
              apiPath: fullPath,
              data: payload,
              token: token
            });

            if (apiResp.success && apiResp.data && apiResp.data.code === 200) {
              if (isUpdate) {
                taskOk++;
                idMap[String(node.id)] = existing.id;
              } else {
                taskOk++;
                var newId = (apiResp.data.data && apiResp.data.data.id) ? apiResp.data.data.id : 0;
                if (newId) {
                  idMap[String(node.id)] = newId;
                } else {
                  var lookupResp = await sendToInject({ type: 'FETCH_RESOURCE_TREE', apiBase: apiBase, appId: testAppId, token: token });
                  if (lookupResp.success && lookupResp.payload) {
                    var freshTree = lookupResp.payload.data || [];
                    if (freshTree.length > 0) testTree = freshTree;
                    var found = findInTarget(parentId, node);
                    if (found) { idMap[String(node.id)] = found.id; newId = found.id; }
                  }
                }
              }

              // 同步 resourceDetailList
              if ((node.type === TYPE_FIELD || node.type === TYPE_DATA) && node.resourceDetailList && node.resourceDetailList.length > 0) {
                var detailTargetId = idMap[String(node.id)] || (existing ? existing.id : 0);
                if (!detailTargetId && newId) detailTargetId = newId;
                if (detailTargetId) {
                  var detailPayload = {
                    itemList: node.resourceDetailList.map(function (d, idx) {
                      return { name: d.name || '', code: d.code || '', isPublicFieldBoolean: d.isPublicFieldBoolean || false, orderNum: idx + 1, appId: testAppId, resourceId: String(detailTargetId) };
                    }),
                    resourceId: String(detailTargetId)
                  };
                  var batchResp = await sendToInject({ type: 'CALL_API', apiPath: apiBase + '/auth2/resource/batchAddDetail', data: detailPayload, token: token });
                  if (batchResp.success && batchResp.data && batchResp.data.code === 200) {
                    taskDetailTotal += node.resourceDetailList.length;
                  } else {
                    addLog('  \u26A0 ' + label + ' \u660E\u7EC6\u540C\u6B65\u5931\u8D25', 'warn');
                  }
                }
              }
            } else {
              taskErr++;
              var errMsg = apiResp.data ? (apiResp.data.msg || 'code=' + apiResp.data.code) : '\u672A\u77E5';
              // 更新失败且目标已删除 → 降级为新增
              if (isUpdate && apiResp.data && apiResp.data.msg && apiResp.data.msg.indexOf('\u4E0D\u5B58\u5728') !== -1) {
                taskErr--;
                delete payload.id;
                var retryPath = API_ROUTES['add_' + node.type];
                try {
                  var retryResp = await sendToInject({ type: 'CALL_API', apiPath: apiBase + retryPath, data: payload, token: token });
                  if (retryResp.success && retryResp.data && retryResp.data.code === 200) {
                    taskOk++;
                    var retryId = (retryResp.data.data && retryResp.data.data.id) ? retryResp.data.data.id : 0;
                    if (retryId) idMap[String(node.id)] = retryId;
                  } else {
                    taskErr++;
                    addLog('  \u2717 ' + label + ' \u65B0\u5EFA(\u964D\u7EA7)\u5931\u8D25', 'error');
                  }
                } catch (e2) { taskErr++; }
              } else {
                addLog('  \u2717 ' + label + ' ' + errMsg, 'error');
              }
            }
          } catch (e) {
            taskErr++;
            addLog('  \u2717 ' + label + ' ' + e.message, 'error');
          }
        }

        // 加入子节点
        if (node.children) {
          node.children.forEach(function (c) { if (c._sel) { c._parentId = node.id; bfsQueue.push(c); } });
        }

        await sleep(150);
        refreshPanel();
      }

      // 汇总
      var summary = '[' + (ti + 1) + '/' + syncTasks.length + '] ' + source.name + ' \u2192 ' + targetName;
      var parts = [];
      if (taskUpdated > 0) parts.push('\u270E' + taskUpdated);
      if (taskOk > 0) parts.push('\u2795' + taskOk);
      if (taskDetailTotal > 0) parts.push('+' + taskDetailTotal + '\u660E\u7EC6');
      if (taskErr > 0) parts.push('\u2717' + taskErr);
      summary += ': ' + parts.join(' ');
      addLog(summary, taskErr > 0 ? 'warn' : 'success');
    }

    addLog('\u2705 \u5168\u90E8\u540C\u6B65\u5B8C\u6210', 'success');

    // 同步完成后清空队列
    syncTasks = [];
    syncStatus = 'done';
    await saveStoredData();

    // 重新采集目标数据
    addLog('\uD83D\uDD04 重新采集目标数据...', 'info');
    await captureCurrentTree('目标');

    syncStatus = 'idle';
    refreshPanel();
  }

  function buildNodePayload(node, parentId) {
    var p = {
      appId: testAppId,
      parentId: parentId || 0,
      type: node.type,
      name: node.name || '',
      orderNum: node.orderNum || 1,
      status: node.status !== undefined ? node.status : 0
    };

    // 目录/菜单字段
    if (node.type === TYPE_DIR || node.type === TYPE_MENU) {
      p.iconCode = node.iconCode || '';
      p.path = node.path || '';
      p.component = node.component || '';
      p.visible = node.visible !== undefined ? node.visible : 0;
      p.isFrame = node.isFrame !== undefined ? node.isFrame : 1;
      if (node.perms) p.perms = node.perms;
    }

    // 菜单特有
    if (node.type === TYPE_MENU) {
      p.query = node.query || '';
      p.isCache = node.isCache !== undefined ? node.isCache : 0;
    }

    // 按钮
    if (node.type === TYPE_BTN) {
      p.perms = node.perms || '';
    }

    // 字段/数据
    if (node.type === TYPE_FIELD || node.type === TYPE_DATA) {
      p.code = node.code || '';
      p.pageKey = node.pageKey || '';
      if (node.type === TYPE_FIELD) {
        p.displayType = node.displayType !== undefined ? node.displayType : 1;
      }
    }

    return p;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ==================== 日志 ====================
  function addLog(msg, type) {
    syncLog.push({ msg: msg, type: type, time: new Date().toLocaleTimeString() });
    if (syncLog.length > 200) syncLog.shift();
    console.log('[Auth Sync] ' + msg);
  }
  function log() { console.log.apply(console, arguments); }

  // ==================== 用户权限同步（应用 + 角色） ====================
  //
  // 与资源同步的区别：资源同步搬"资源树"（目录/菜单/按钮/字段/数据），
  // 本功能搬"某个账号的应用+角色绑定"。两者共用同一套底层能力
  // （页面注入代理、Admin-Token、CALL_API 通道），所以不需要任何新增后端接口。
  //
  // 三条不可动摇的约束（推导过程见 perm-map.js 顶部注释与设计稿）：
  //   1. 跨环境 ID 不可复用 —— 只能按 appCode / appCode+roleCode 映射，绝不按名称近似匹配。
  //   2. 写操作必须 read-modify-write，且只提交页面 formState 会提交的字段。
  //      原因：editUser 是全量表单提交，少传字段会被当成置空。
  //   3. 权限已一致时不发任何写请求（幂等）。执行后必须回读校验，不能只看接口 200。

  // 同步方式不存状态：由两个快照的宿主环境自动推导（AuthPermMap.inferMode）。
  // 原先做成手选开关是设计冗余 —— 同环境下"跨环境"分支只是把 appId 翻译成
  // appCode 再翻回来，与"同环境"分支结果等价，徒增选错的机会。
  var srcSnapshot = null;           // 源账号快照（从它复制权限）
  var tgtSnapshot = null;           // 目标账号快照（被修改的那个）
  var _userPlan = null;             // 最近一次算出的执行计划
  var _userBusy = false;

  /** 当前该用哪条映射路径；未采齐时返回 null */
  function currentMode() {
    return AuthPermMap.inferMode(srcSnapshot, tgtSnapshot);
  }

  var USER_LIST_PAGE_SIZE = 100;

  /**
   * 调一个 /auth2 接口并返回其 data；失败抛出带后端 msg 的错误。
   * headers 用于透传页面自己会带的自定义头 —— 必须与页面一致，
   * 否则会撞上后端的数据权限校验（如 listByPage 缺 page_key 直接报错）。
   */
  async function apiCall(path, data, headers) {
    var apiBase = await getApiBaseOrigin();
    var resp = await sendToInject({
      type: 'CALL_API',
      apiPath: apiBase + path,
      data: data,
      token: getToken(),
      headers: headers || null
    });
    if (!resp || !resp.success) throw new Error((resp && resp.error) || '请求失败');
    var result = resp.data;
    if (!result) throw new Error('响应为空');
    if (result.code !== 200) throw new Error(result.msg || ('接口返回 code=' + result.code));
    return result.data;
  }

  // 页面 getUserList 就是这么带的（auth-web/src/api/userManagement/index.ts:9-22），
  // 缺了后端会回「无数据权限，页面key不能为空」。
  var USER_PAGE_HEADERS = { page_key: 'auth2:userManagement' };

  /**
   * 按账号名查 userId。
   * 先用 userName 条件查（后端支持则一次命中），再翻页兜底 —— 不假设后端真的过滤了条件。
   */
  async function findUserIdByAccount(account) {
    var wanted = String(account).trim().toLowerCase();
    var seen = 0;
    for (var page = 1; page <= 20; page++) {
      var data = await apiCall('/auth2/user/listByPage', {
        pageNum: page,
        pageSize: USER_LIST_PAGE_SIZE,
        userName: account
      }, USER_PAGE_HEADERS);
      var rows = (data && (data.records || data.list || data.rows)) || (Array.isArray(data) ? data : []);
      if (!rows.length) break;
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].userName || '').toLowerCase() === wanted) {
          return rows[i].userId || rows[i].id;
        }
      }
      seen += rows.length;
      var total = data && data.total;
      if (total !== undefined && seen >= total) break;
    }
    throw new Error('当前环境找不到账号「' + account + '」');
  }

  /**
   * 采集一个账号的权限快照：用户详情 + 本环境的应用/角色枚举。
   * 为什么要连枚举一起存：跨环境时源环境的 id 在目标环境无意义，
   * 必须靠源快照里的 id→code 映射才能翻译过去。
   */
  async function captureUserSnapshot(which) {
    var inputEl = document.getElementById(which === 'src' ? 'as-src-account' : 'as-tgt-account');
    var account = inputEl ? String(inputEl.value || '').trim() : '';
    var roleName = which === 'src' ? '源' : '目标';
    if (!account) {
      addLog('[用户同步] 请先输入' + roleName + '账号', 'warn');
      refreshPanel();
      return;
    }

    _userBusy = true; refreshPanel();
    try {
      addLog('[用户同步] 正在采集 ' + roleName + '账号 ' + account + ' ...');
      var userId = await findUserIdByAccount(account);
      var detail = await apiCall('/auth2/user/selectUserDetail', { userId: userId });
      var apps = await apiCall('/auth2/app/selectApp', {});
      // ids 传空数组时后端返回全部角色（实测 94 条），一次拿全，省掉按应用逐个查
      var roles = await apiCall('/auth2/role/selectAppRole', { ids: [] });
      var apiBase = await getApiBaseOrigin();

      var snap = {
        env: { host: window.location.hostname, apiBase: apiBase },
        account: account,
        userId: userId,
        apps: apps || [],
        roles: roles || [],
        appIdList: (detail && detail.appIdList) || [],
        roleIdList: (detail && detail.roleIdList) || [],
        detail: detail || {},
        capturedAt: Date.now()
      };
      if (which === 'src') srcSnapshot = snap; else tgtSnapshot = snap;

      addLog('[用户同步] 已采集 ' + account + '：应用 ' + snap.appIdList.length +
             ' 个 / 角色 ' + snap.roleIdList.length + ' 个（本环境可选 ' +
             snap.apps.length + ' 应用 / ' + snap.roles.length + ' 角色）', 'success');
      _userPlan = null;
      await saveStoredData();
      refreshPanel();
      if (srcSnapshot && tgtSnapshot) renderUserPreview();   // 两边齐了自动算差异
    } catch (e) {
      addLog('[用户同步] 采集失败：' + e.message, 'error');
      refreshPanel();
    } finally {
      _userBusy = false;
      refreshPanel();
    }
  }

  /** 把应用/角色 id 翻译成可读标签（用采集到的枚举） */
  function labelOfApp(snap, id) {
    var hit = (snap.apps || []).filter(function (x) { return String(x.id) === String(id); })[0];
    return hit ? (hit.appCode + (hit.appName ? '(' + hit.appName + ')' : '')) : ('id=' + id);
  }
  /**
   * 角色标签必须带应用前缀。
   * 原因：roleCode 只在单个应用内唯一（实测 liwei 的差异里有 4 个不同角色都叫 admin），
   * 不带应用就会出现多个看起来完全相同的条目，用户根本无法核对。
   */
  function labelOfRole(snap, id) {
    var hit = (snap.roles || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!hit) return 'id=' + id;
    var app = (snap.apps || []).filter(function (x) { return String(x.id) === String(hit.appId); })[0];
    var core = hit.roleCode || hit.roleName || ('id=' + id);
    return (app ? app.appCode + '/' : '') + core;
  }

  /** 算差异并渲染预览。这是执行前的最后一道人工确认关卡。 */
  function renderUserPreview() {
    var box = document.getElementById('as-user-preview');
    if (!box) return;

    if (!srcSnapshot || !tgtSnapshot) {
      box.innerHTML = '<div class="as-pv-same">源账号与目标账号都采集后，这里会显示差异。</div>';
      _userPlan = null;
      refreshPanel();
      return;
    }

    var plan = AuthPermMap.plan({
      source: srcSnapshot,
      target: { apps: tgtSnapshot.apps, roles: tgtSnapshot.roles },
      currentDetail: tgtSnapshot.detail,
      mode: currentMode() || 'same-env'
    });
    _userPlan = plan;

    var html = '';
    if (plan.noop) {
      // 幂等：完全一致时明确告知不会发任何写请求
      html += '<div class="as-pv-noop">\u2714 权限已完全一致，无需写入</div>';
    } else {
      html += diffBlock('应用', plan.appDiff, tgtSnapshot, labelOfApp);
      html += diffBlock('角色', plan.roleDiff, tgtSnapshot, labelOfRole);
    }
    if (plan.unresolved.length) {
      html += '<div class="as-pv-title">\u26A0 无法映射（将跳过，需人工处理）</div>';
      plan.unresolved.forEach(function (u) {
        // 角色同样带应用前缀，否则多个应用的 roleCode 重名时无法区分
        var who = u.kind === 'app'
          ? ('应用 ' + (u.appCode || u.code || ''))
          : ('角色 ' + (u.appCode ? u.appCode + '/' : '') + (u.roleCode || u.roleName || u.code || ''));
        html += '<div class="as-pv-unres">\u2022 ' + escHtml(who) + ' —— ' + escHtml(u.reason) + '</div>';
      });
    }
    if (plan.warnings.length) {
      html += '<div class="as-pv-title">\u26A0 数据异常提醒</div>';
      plan.warnings.forEach(function (w) {
        html += '<div class="as-pv-unres">\u2022 ' + escHtml(w.reason) + '</div>';
      });
    }
    box.innerHTML = html;
    refreshPanel();
  }

  function diffBlock(title, diff, snap, labeler) {
    var h = '<div class="as-pv-title">' + title + '（+' + diff.added.length +
            ' / -' + diff.removed.length + ' / =' + diff.same.length + '）</div>';
    diff.added.forEach(function (id) {
      h += '<div class="as-pv-add">\u271A 新增&nbsp;&nbsp;' + escHtml(labeler(snap, id)) + '</div>';
    });
    diff.removed.forEach(function (id) {
      h += '<div class="as-pv-del">\u2716 移除&nbsp;&nbsp;' + escHtml(labeler(snap, id)) + '</div>';
    });
    if (!diff.added.length && !diff.removed.length) {
      h += '<div class="as-pv-same">= 全部一致</div>';
    }
    return h;
  }

  /** 解 JWT payload（base64url，可能缺 padding） */
  function jwtPayload(token) {
    try {
      var p = String(token || '').split('.')[1];
      if (!p) return null;
      p = p.replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(atob(p));
    } catch (e) { return null; }
  }

  /**
   * 当前登录人的 userId。
   * 优先读应用自己写进 localStorage 的 USERID（实测存在），
   * 读不到再解 Admin-Token 的 payload（实测含 user_id）。
   */
  function currentUserId() {
    try {
      var u = localStorage.getItem('USERID');
      if (u) return String(u).replace(/^"|"$/g, '');
    } catch (e) {}
    var p = jwtPayload(getToken().replace(/^Bearer\s+/i, ''));
    return (p && p.user_id) ? String(p.user_id) : '';
  }

  /**
   * 疑似超级管理员的判定 —— 实现在 perm-map.js 里（纯函数、有单测覆盖），
   * 这里只做一层转调，避免同一套判据在两处漂移。
   */
  function superAdminReason(snap) {
    return AuthPermMap.superAdminReason(snap);
  }

  /**
   * 执行同步：read-modify-write → editUser → 回读校验。
   * 回读这一步不能省：接口返回 200 不等于权限真的写对了。
   */
  async function executeUserSync() {
    if (!_userPlan) { addLog('[用户同步] 请先刷新差异预览', 'warn'); refreshPanel(); return; }
    if (!tgtSnapshot) return;
    if (_userPlan.noop) { addLog('[用户同步] 权限已一致，未发送任何写请求', 'success'); refreshPanel(); return; }

    var removedApps = _userPlan.appDiff.removed.length;
    var removedRoles = _userPlan.roleDiff.removed.length;
    var msg = '确认把账号「' + tgtSnapshot.account + '」的应用与角色同步为源账号的配置？\n\n' +
              '应用：新增 ' + _userPlan.appDiff.added.length + ' / 移除 ' + removedApps + '\n' +
              '角色：新增 ' + _userPlan.roleDiff.added.length + ' / 移除 ' + removedRoles + '\n';
    if (removedApps || removedRoles) {
      msg += '\n⚠ 将会移除 ' + removedApps + ' 个应用、' + removedRoles + ' 个角色，请先核对预览。\n';
    }
    msg += '\n用户基础信息（姓名/部门/手机号/邮箱等）不会改动。';

    // 边界 5：目标就是自己 —— 有把自己锁在权限管理页之外的风险
    var meId = currentUserId();
    if (meId && tgtSnapshot.userId && String(meId) === String(tgtSnapshot.userId) && (removedApps || removedRoles)) {
      msg += '\n\n⚠⚠ 目标账号就是你自己！\n' +
             '本次将移除 ' + (removedApps + removedRoles) + ' 项权限。' +
             '若其中包含用户管理权限，你可能把自己锁在权限管理页面之外。\n' +
             '建议改用另一个管理员账号来操作。';
    }
    // 边界 6：疑似超管账号
    var adminWhy = superAdminReason(tgtSnapshot);
    if (adminWhy) msg += '\n\n⚠ 目标账号疑似超级管理员（' + adminWhy + '），请确认这是你要改的账号。';

    if (!window.confirm(msg)) { addLog('[用户同步] 已取消执行', 'warn'); return; }

    _userBusy = true; refreshPanel();
    try {
      // 提交前重新拉一次目标用户详情：预览与执行之间目标数据可能已被页面改动
      var fresh = await apiCall('/auth2/user/selectUserDetail', { userId: tgtSnapshot.userId });
      var payload = AuthPermMap.buildEditPayload(fresh, _userPlan.appIdList, _userPlan.roleIdList);
      await apiCall('/auth2/user/editUser', payload);
      addLog('[用户同步] 已提交 editUser（应用 ' + payload.appIdList.length +
             ' / 角色 ' + payload.roleIdList.length + '）', 'success');

      var after = await apiCall('/auth2/user/selectUserDetail', { userId: tgtSnapshot.userId });
      var wantApps = _userPlan.appIdList.slice().sort().join(',');
      var wantRoles = _userPlan.roleIdList.slice().sort().join(',');
      var gotApps = (after.appIdList || []).slice().sort().join(',');
      var gotRoles = (after.roleIdList || []).slice().sort().join(',');
      if (wantApps === gotApps && wantRoles === gotRoles) {
        addLog('[用户同步] \u2714 回读校验通过：应用 ' + (after.appIdList || []).length +
               ' 个 / 角色 ' + (after.roleIdList || []).length + ' 个', 'success');
      } else {
        addLog('[用户同步] \u2716 回读不一致！期望应用[' + wantApps + '] 实际[' + gotApps +
               ']；期望角色[' + wantRoles + '] 实际[' + gotRoles + ']', 'error');
      }

      // 顺带自检基础信息有没有被这次提交改掉（read-modify-write 的正确性）
      var baseKeys = ['userName', 'nickName', 'sex', 'userType', 'deptId', 'phonenumber', 'email', 'partner'];
      var changed = baseKeys.filter(function (k) {
        return JSON.stringify(fresh[k]) !== JSON.stringify(after[k]);
      });
      if (changed.length) addLog('[用户同步] \u26A0 基础信息发生变化：' + changed.join(', '), 'warn');

      tgtSnapshot.detail = after;
      tgtSnapshot.appIdList = after.appIdList || [];
      tgtSnapshot.roleIdList = after.roleIdList || [];
      await saveStoredData();
      _userPlan = null;
      renderUserPreview();
    } catch (e) {
      addLog('[用户同步] 执行失败：' + e.message, 'error');
    } finally {
      _userBusy = false;
      refreshPanel();
    }
  }

  function resetUserSync() {
    srcSnapshot = null;
    tgtSnapshot = null;
    _userPlan = null;
    var a = document.getElementById('as-src-account'); if (a) a.value = '';
    var b = document.getElementById('as-tgt-account'); if (b) b.value = '';
    var p = document.getElementById('as-user-preview'); if (p) p.innerHTML = '';
    saveStoredData();
    refreshPanel();
  }

  function switchTopTab(tab) {
    var isUser = tab === 'user';
    var pres = document.getElementById('as-pane-res');
    var puser = document.getElementById('as-pane-user');
    if (pres) pres.style.display = isUser ? 'none' : '';
    if (puser) puser.style.display = isUser ? '' : 'none';
    var t1 = document.getElementById('as-tab-res');
    var t2 = document.getElementById('as-tab-user');
    if (t1) t1.classList.toggle('as-tab-active', !isUser);
    if (t2) t2.classList.toggle('as-tab-active', isUser);
    if (isUser) renderUserPreview();
  }

  /** 渲染用户权限同步面板的状态（快照摘要 + 按钮可用性 + 模式高亮） */
  function renderUserPane() {
    var envEl = document.getElementById('as-user-env');
    if (envEl) envEl.textContent = window.location.hostname;

    // 同步方式自动判定，并说明用的是哪条路径 —— 不给用户选错的机会
    var modeEl = document.getElementById('as-user-mode');
    if (modeEl) {
      var mode = currentMode();
      if (!mode) {
        modeEl.textContent = '采集两个账号后自动判定';
        modeEl.className = 'as-mode-info';
      } else if (mode === 'same-env') {
        modeEl.textContent = '\uD83D\uDCCB 同一环境 · 按 ID 直连';
        modeEl.className = 'as-mode-info as-mode-info-same';
      } else {
        modeEl.textContent = '\uD83C\uDF10 跨环境 · 按应用/角色编码映射';
        modeEl.className = 'as-mode-info as-mode-info-cross';
      }
    }

    var snapEl = document.getElementById('as-user-snap');
    if (snapEl) {
      snapEl.innerHTML = [
        snapshotLine('源', srcSnapshot),
        snapshotLine('目标', tgtSnapshot)
      ].join('\n');
    }

    var execBtn = document.getElementById('as-user-exec');
    if (execBtn) {
      // 只有"算出了差异且确实需要写"时才允许执行；处理中一律禁用
      execBtn.disabled = _userBusy || !_userPlan || _userPlan.noop;
      if (_userBusy) {
        execBtn.textContent = '\u23F3 处理中...';
      } else if (_userPlan && !_userPlan.noop) {
        var add = _userPlan.appDiff.added.length + _userPlan.roleDiff.added.length;
        var del = _userPlan.appDiff.removed.length + _userPlan.roleDiff.removed.length;
        execBtn.textContent = '\u26A1 执行同步 (+' + add + ' / -' + del + ')';
      } else {
        execBtn.textContent = '\u26A1 执行同步';
      }
    }

    var cap1 = document.getElementById('as-capture-src');
    var cap2 = document.getElementById('as-capture-tgt');
    if (cap1) cap1.disabled = _userBusy;
    if (cap2) cap2.disabled = _userBusy;
  }

  function snapshotLine(role, snap) {
    if (!snap) return role + '：<span class="as-snap-warn">未采集</span>';
    var mins = Math.round((Date.now() - snap.capturedAt) / 60000);
    var stale = mins > 1440
      ? ' <span class="as-snap-warn">(采集于 ' + Math.round(mins / 60) + ' 小时前，建议重新采集)</span>'
      : '';
    return role + '：<b>' + escHtml(snap.account) + '</b> @ ' + escHtml(snap.env.host) +
           '　应用 ' + snap.appIdList.length + ' / 角色 ' + snap.roleIdList.length +
           '　<span class="as-snap-ok">已采集</span>' + stale;
  }

  // ==================== 面板 UI ====================
  function createFloatingPanel() {
    try {
      panelEl = document.createElement('div');
      panelEl.id = 'auth-sync-panel';
      panelEl.innerHTML =
        '<div id="as-toggle" class="as-toggle-btn">' +
          '<span class="as-toggle-icon">\uD83D\uDD17</span>' +
          '<span id="as-badge" class="as-badge" style="display:none">0</span>' +
        '</div>' +
        '<div class="as-body" id="as-body" style="display:none">' +
          // 拖拽手柄（左侧）
          '<div id="as-resize-handle" class="as-resize-handle"></div>' +
          // header
          '<div class="as-header">' +
            '<span>\uD83D\uDD17 Auth Resource Sync</span>' +
            '<div style="display:flex;gap:4px">' +
              '<button id="as-help-btn" class="as-btn as-btn-xs" title="帮助">\u2753</button>' +
              '<span id="as-close" class="as-close">\u2715</span>' +
            '</div>' +
          '</div>' +
          // 顶层能力切换：资源同步（原有） / 用户权限同步（新增）
          '<div class="as-tabs">' +
            '<button id="as-tab-res" class="as-tab as-tab-active">\uD83D\uDCE6 资源同步</button>' +
            '<button id="as-tab-user" class="as-tab">\uD83D\uDC64 用户权限同步</button>' +
          '</div>' +
          // 内容区：资源同步
          '<div class="as-content as-pane" id="as-pane-res">' +
            // ── 工具栏 ──
            '<div class="as-toolbar">' +
              '<div class="as-toolbar-row">' +
                '<span class="as-label">采集:</span>' +
                '<button id="as-capture-dev" class="as-btn as-btn-sm">\uD83D\uDCE5 采集源数据</button>' +
                '<button id="as-capture-test" class="as-btn as-btn-sm">\uD83D\uDCE5 采集目标数据</button>' +
                '<span style="margin-left:8px;font-size:10px;color:#888">当前: <b id="as-current-env">-</b></span>' +
              '</div>' +
              '<div class="as-toolbar-row" style="margin-top:4px">' +
                '<span class="as-label">appId:</span>' +
                '<input id="as-appid-input" class="as-appid-input" placeholder="自动检测..." style="width:80px;padding:2px 6px;border:1px solid #d9d9d9;border-radius:4px;font-size:11px" />' +
                '<span id="as-appid-hint" style="font-size:9px;color:#bbb;margin-left:4px">留空则自动检测</span>' +
              '</div>' +
            '</div>' +
            // ── 三栏布局 ──
            '<div class="as-main-area">' +
              // 左：源数据
              '<div class="as-tree-col as-tree-dev">' +
                '<div class="as-tree-header">\uD83D\uDCF1 源数据 (<span id="as-dev-count">0</span>)' +
                  '<span style="margin-left:auto;display:flex;gap:2px">' +
                    '<button class="as-btn as-btn-xs" id="as-dev-expand-all" title="\u5C55\u5F00\u5168\u90E8">\u25BC</button>' +
                    '<button class="as-btn as-btn-xs" id="as-dev-collapse-all" title="\u6298\u53E0\u5168\u90E8">\u25B2</button>' +
                    '<button class="as-btn as-btn-xs" id="as-dev-sel-all" title="\u5168\u9009/\u53D6\u6D88">\u2611</button>' +
                  '</span>' +
                '</div>' +
                '<div class="as-tree-search">' +
                  '<input id="as-dev-search" class="as-search-input" placeholder="\uD83D\uDD0D 搜索节点..." />' +
                '</div>' +
                '<div id="as-dev-tree" class="as-tree-body"></div>' +
              '</div>' +
              // 中：目标数据
              '<div class="as-tree-col as-tree-test">' +
                '<div class="as-tree-header">\uD83C\uDFAF 目标数据 (<span id="as-test-count">0</span>)' +
                  '<span style="margin-left:auto;display:flex;gap:2px">' +
                    '<button class="as-btn as-btn-xs" id="as-test-expand-all" title="\u5C55\u5F00\u5168\u90E8">\u25BC</button>' +
                    '<button class="as-btn as-btn-xs" id="as-test-collapse-all" title="\u6298\u53E0\u5168\u90E8">\u25B2</button>' +
                  '</span>' +
                '</div>' +
                '<div class="as-tree-search">' +
                  '<input id="as-test-search" class="as-search-input" placeholder="\uD83D\uDD0D 搜索节点..." />' +
                '</div>' +
                '<div id="as-test-tree" class="as-tree-body"></div>' +
                '<div class="as-tree-footer" id="as-target-info">\uD83D\uDC46 点击选择目标父节点</div>' +
              '</div>' +
              // 右：任务队列
              '<div class="as-queue-col">' +
                '<div class="as-tree-header" style="display:flex;align-items:center;justify-content:space-between">' +
                  '<span>\uD83D\uDCCB \u540C\u6B65\u961F\u5217 (<span id="as-queue-count">0</span>)</span>' +
                  '<div style="display:flex;gap:2px">' +
                    '<button id="as-mode-batch" class="as-btn as-btn-xs as-mode-btn" title="\u6279\u91CF\u540C\u6B65\uFF1A\u5C06\u6574\u9762\u529F\u80FD\u4ECE\u6E90\u73AF\u5883\u642C\u8FD0\u5230\u76EE\u6807\u73AF\u5883\uFF08\u5305\u542B\u5B50\u6811\uFF09\uFF0C\u9002\u7528\u4E8E\u65B0\u6A21\u5757\u6574\u4F53\u8FC1\u79FB\u3002">\u6279\u91CF</button>' +
                    '<button id="as-mode-single" class="as-btn as-btn-xs as-mode-btn" title="\u5355\u70B9\u66F4\u65B0\uFF1A\u5C06\u6E90\u73AF\u5883\u67D0\u4E2A\u8282\u70B9\u7684\u914D\u7F6E\u7CBE\u786E\u8986\u76D6\u5230\u76EE\u6807\u73AF\u5883\u7684\u5BF9\u5E94\u8282\u70B9\uFF08\u4E0D\u52A8\u5B50\u8282\u70B9\uFF09\uFF0C\u9002\u7528\u4E8E\u5C0F\u8303\u56F4\u4FEE\u6539\u3002">\u5355\u70B9</button>' +
                  '</div>' +
                '</div>' +
                '<div id="as-queue-list" class="as-queue-body"></div>' +
                '<div class="as-queue-actions">' +
                  '<button id="as-add-queue" class="as-btn as-btn-primary as-btn-sm" style="width:100%">\u2795 \u52A0\u5165\u6279\u91CF\u961F\u5217</button>' +
                  '<button id="as-update-single" class="as-btn as-btn-warning as-btn-sm" style="width:100%;display:none">\uD83C\uDFAF \u66F4\u65B0\u5230\u9009\u4E2D\u8282\u70B9</button>' +
                  '<button id="as-exec-sync" class="as-btn as-btn-success as-btn-sm" style="width:100%">\uD83D\uDCE4 \u6267\u884C\u961F\u5217</button>' +
                  '<button id="as-clear-queue" class="as-btn as-btn-danger as-btn-sm" style="width:100%">\uD83D\uDDD1 \u6E05\u7A7A\u961F\u5217</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          // 内容区：用户权限同步（新增）
          // 设计要点：源/目标两个账号各自"采集"，采集即把该环境的
          // selectUserDetail + selectApp + selectAppRole 快照存下来。
          // 跨环境时切到目标环境的页面再采集目标账号 —— 这样两个环境的
          // token 与 API 基址都由各自页面提供，插件不需要跨域凭据。
          '<div class="as-content as-pane" id="as-pane-user" style="display:none">' +
            '<div class="as-toolbar">' +
              '<div class="as-toolbar-row">' +
                '<span class="as-label">方式:</span>' +
                // 不再让用户手选：同一环境下两条映射路径等价，选错只会带来困惑。
                // 由两个快照的宿主环境自动推导（见 perm-map.inferMode）。
                '<span id="as-user-mode" class="as-mode-info">采集两个账号后自动判定</span>' +
                '<span style="margin-left:8px;font-size:10px;color:#888">当前: <b id="as-user-env">-</b></span>' +
              '</div>' +
            '</div>' +
            '<div class="as-user-body">' +
              '<div class="as-user-row">' +
                '<span class="as-label" id="as-src-label">源账号:</span>' +
                '<input id="as-src-account" class="as-user-input" placeholder="输入账号，如 testAPSAuth" />' +
                '<button id="as-capture-src" class="as-btn as-btn-sm">\uD83D\uDCE5 采集源账号</button>' +
              '</div>' +
              '<div class="as-user-row">' +
                '<span class="as-label">目标账号:</span>' +
                '<input id="as-tgt-account" class="as-user-input" placeholder="输入账号" />' +
                '<button id="as-capture-tgt" class="as-btn as-btn-sm">\uD83D\uDCE5 采集目标账号</button>' +
              '</div>' +
              '<div class="as-user-snap" id="as-user-snap">\u2460 先采集源账号，\u2461 再采集目标账号</div>' +
              '<div class="as-user-preview" id="as-user-preview"></div>' +
              '<div class="as-user-actions">' +
                '<button id="as-user-refresh" class="as-btn as-btn-primary as-btn-sm">\uD83D\uDD04 刷新差异预览</button>' +
                '<button id="as-user-exec" class="as-btn as-btn-success as-btn-sm" disabled>\u26A1 执行同步</button>' +
                '<button id="as-user-reset" class="as-btn as-btn-danger as-btn-sm">\uD83D\uDDD1 清空</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          // ── 日志（两个面板共用，故放在面板最外层）──
          '<div class="as-log-wrap" id="as-log-wrap">' +
            '<div class="as-log-title" id="as-log-toggle">' +
              '<span>\uD83D\uDCCB 日志</span>' +
              '<span id="as-log-count" style="margin-left:8px"></span>' +
              '<span style="margin-left:auto;font-size:10px">\u25BC 展开</span>' +
            '</div>' +
            '<div id="as-log" class="as-log-body as-log-collapsed"></div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(panelEl);

      // 事件绑定
      bindClick('as-toggle', function () {
        isPanelOpen = !isPanelOpen;
        if (isPanelOpen) {
          loadStoredData().then(function () {
            addParentIdArr(devTree);
            addParentIdArr(testTree);
            refreshPanel();
          });
        } else {
          refreshPanel();
        }
      });
      bindClick('as-close', function () { isPanelOpen = false; refreshPanel(); });
      bindClick('as-capture-dev', function () { captureCurrentTree('源'); });
      bindClick('as-capture-test', function () { captureCurrentTree('目标'); });
      bindClick('as-add-queue', addToQueue);
      bindClick('as-exec-sync', function () { if (syncMode === 'single') executeSingleUpdates(); else executeSync(); });
      bindClick('as-clear-queue', function () { if (syncMode === 'single') clearSingleQueue(); else clearQueue(); });
      bindClick('as-update-single', addSingleUpdate);
      bindClick('as-mode-batch', function () { switchMode('batch'); });
      bindClick('as-mode-single', function () { switchMode('single'); });
      bindClick('as-help-btn', function () {
        window.open(chrome.runtime.getURL('help.html'), '_blank');
      });
      // ── 顶层能力切换 ──
      bindClick('as-tab-res', function () { switchTopTab('res'); });
      bindClick('as-tab-user', function () { switchTopTab('user'); });
      // ── 用户权限同步 ──
      bindClick('as-capture-src', function () { captureUserSnapshot('src'); });
      bindClick('as-capture-tgt', function () { captureUserSnapshot('tgt'); });
      bindClick('as-user-refresh', function () { renderUserPreview(); });
      bindClick('as-user-exec', function () { executeUserSync(); });
      bindClick('as-user-reset', function () { resetUserSync(); });
      // 源数据：展开/折叠/全选
      bindClick('as-dev-expand-all', function () { setAllExpanded(devTree, expandedDev, true); saveStoredData(); refreshPanel(); });
      bindClick('as-dev-collapse-all', function () { expandedDev = {}; refreshPanel(); });
      bindClick('as-dev-sel-all', function () { toggleSelectAllDev(); });
      // 目标数据：展开/折叠
      bindClick('as-test-expand-all', function () { setAllExpanded(testTree, expandedTest, true); refreshPanel(); });
      bindClick('as-test-collapse-all', function () { expandedTest = {}; refreshPanel(); });

      // 日志折叠
      bindClick('as-log-toggle', function () {
        var logBody = document.getElementById('as-log');
        if (!logBody) return;
        var toggle = document.getElementById('as-log-toggle');
        var isCollapsed = logBody.classList.contains('as-log-collapsed');
        if (isCollapsed) {
          logBody.classList.remove('as-log-collapsed');
          if (toggle) toggle.querySelector('span:last-child').textContent = '\u25B2 收起';
        } else {
          logBody.classList.add('as-log-collapsed');
          if (toggle) toggle.querySelector('span:last-child').textContent = '\u25BC 展开';
        }
      });

      // 源数据搜索
      var devSearch = document.getElementById('as-dev-search');
      if (devSearch) {
        devSearch.addEventListener('input', function () {
          devSearchText = this.value.toLowerCase();
          if (devSearchText) autoExpandSearch(devTree, expandedDev, devSearchText);
          renderDevTree();
        });
      }

      // 目标数据搜索
      var testSearch = document.getElementById('as-test-search');
      if (testSearch) {
        testSearch.addEventListener('input', function () {
          testSearchText = this.value.toLowerCase();
          if (testSearchText) autoExpandSearch(testTree, expandedTest, testSearchText);
          renderTestTree();
        });
      }

      // 源数据点击委托
      var devTreeEl = document.getElementById('as-dev-tree');
      if (devTreeEl) {
        devTreeEl.addEventListener('click', function (e) {
          var cb = e.target.closest && e.target.closest('.as-cb');
          if (cb) {
            var id = cb.getAttribute('data-id');
            var node = findNodeById(devTree, id);
            if (node) toggleDevNode(node);
            return;
          }
          var expander = e.target.closest && e.target.closest('.as-expand');
          if (expander) {
            var id = expander.getAttribute('data-id');
            expandedDev[id] = !expandedDev[id];
            renderDevTree();
            return;
          }
        });
      }

      // 目标数据点击委托
      var testTreeEl = document.getElementById('as-test-tree');
      if (testTreeEl) {
        testTreeEl.addEventListener('click', function (e) {
          var expander = e.target.closest && e.target.closest('.as-expand');
          if (expander) {
            var id = expander.getAttribute('data-id');
            expandedTest[id] = !expandedTest[id];
            renderTestTree();
            return;
          }
          var target = e.target.closest && e.target.closest('.as-test-node');
          if (target) {
            var id = target.getAttribute('data-id');
            selectedTestNodeId = id;
            renderDevTree();
            renderTestTree();
            updateTargetInfo();
            return;
          }
        });
      }

      // 队列删除 + 展开委托
      var queueList = document.getElementById('as-queue-list');
      if (queueList) {
        queueList.addEventListener('click', function (e) {
          var del = e.target.closest && e.target.closest('.as-task-del');
          if (del) {
            var idx = parseInt(del.getAttribute('data-idx'), 10);
            removeTask(idx);
            return;
          }
          var expand = e.target.closest && e.target.closest('.as-task-expand');
          if (expand) {
            var idx = parseInt(expand.getAttribute('data-idx'), 10);
            expandedQueue[idx] = !expandedQueue[idx];
            renderQueue();
            return;
          }
        });
      }

      setupDrag();
      setupResizeHandle();
      refreshPanel();

      // 窗口大小变化时自动调整面板高度
      window.addEventListener('resize', function () {
        var body = document.getElementById('as-body');
        if (body && isPanelOpen) {
          body.style.height = Math.floor(window.innerHeight * 0.8) + 'px';
        }
      });
    } catch (e) { console.error('[Auth Sync] Panel create:', e); }
  }

  function bindClick(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  function updateTargetInfo() {
    var infoEl = document.getElementById('as-target-info');
    if (!infoEl) return;
    if (!selectedTestNodeId) {
      infoEl.innerHTML = '\uD83D\uDC46 \u70B9\u51FB\u9009\u62E9\u76EE\u6807\u7236\u8282\u70B9 <span style="opacity:0.55">\uFF5C \u7EFF\u8272=\u65B0\u589E \u9EC4\u8272=\u66F4\u65B0</span>';
      infoEl.style.color = '#888';
      return;
    }
    var node = findNodeById(testTree, selectedTestNodeId);
    if (node) {
      var path = getNodePath(testTree, selectedTestNodeId);
      infoEl.innerHTML = '\uD83C\uDFAF 目标: <b>' + escHtml(node.name) + '</b> [' + TYPE_NAMES[node.type] + '] <span style="font-size:9px;color:#888">' + escHtml((path || []).join(' > ')) + '</span>';
      infoEl.style.color = '#1890ff';
    }
  }

  // ==================== 树渲染 ====================
  function renderDevTree() {
    var el = document.getElementById('as-dev-tree');
    if (!el) return;
    var html = '';
    var selId = selectedTestNodeId;
    devTree.forEach(function (n) {
      html += renderDevNode(n, 0, selId);
    });
    el.innerHTML = html || '<div class="as-empty">点击「采集源数据」拉取数据</div>';
    // 设置半选状态
    el.querySelectorAll('.as-cb-partial').forEach(function (cb) { cb.indeterminate = true; });

    var cntEl = document.getElementById('as-dev-count');
    if (cntEl) cntEl.textContent = countNodes(devTree);
  }

  function renderDevNode(node, depth, targetParentId) {
    var hasChildren = node.children && node.children.length > 0;
    var hasDetails = node.resourceDetailList && node.resourceDetailList.length > 0;
    var canExpand = hasChildren || hasDetails;
    var isExpanded = expandedDev[String(node.id)] === true;
    // 单点模式：直接按自身 _sel；批量模式：按子孙联动
    var checkedState = syncMode === 'single' ? (node._sel ? 'checked' : 'unchecked') : getNodeCheckedState(node);
    var matchesSearch = !devSearchText || nodeMatchesSearch(node, devSearchText);

    // 搜索过滤：如果节点不匹配搜索且没有匹配的子节点，隐藏
    if (devSearchText && !matchesSearch) {
      var childMatch = false;
      if (hasChildren) {
        childMatch = node.children.some(function (c) { return anyNodeMatchesSearch(c, devSearchText); });
      }
      if (!childMatch) return '';
    }

    var html = '';
    var padLeft = depth * 18;

    // 颜色标记：绿色=新增，黄色=更新
    // targetParentId 是该节点在目标树中应挂载的父节点 id
    //   - 根选中节点：selectedTestNodeId
    //   - 父节点匹配到目标节点：父节点在目标中的 id
    //   - 父节点是新增：null（子节点必然也是新增）
    //   - 父节点未勾选：继承父的 targetParentId（子节点自己成为根）
    var syncStateClass = '';
    var matchedTarget = null;
    if (node._sel) {
      if (syncMode === 'single') {
        // 单点模式：都是更新（黄色）
        syncStateClass = selectedTestNodeId ? ' as-sync-update' : '';
        matchedTarget = null;
      } else if (testTree.length > 0 && selectedTestNodeId) {
        if (targetParentId != null) {
          matchedTarget = findInTarget(targetParentId, node);
          if (matchedTarget) {
            syncStateClass = nodesEqual(matchedTarget, node) ? '' : ' as-sync-update';
          } else {
            syncStateClass = ' as-sync-new';
          }
        } else {
          syncStateClass = ' as-sync-new';
        }
      }
    }

    // 计算子节点的 targetParentId
    var childTargetParentId;
    if (node._sel) {
      childTargetParentId = matchedTarget ? matchedTarget.id : null;
    } else {
      childTargetParentId = targetParentId;
    }

    // 构建 tooltip
    var tooltip = node.name || node.code || '(空)';
    if (node.perms) tooltip += ' | perms: ' + node.perms;
    if (node.path) tooltip += ' | path: ' + node.path;
    if (node.code) tooltip += ' | code: ' + node.code;
    tooltip += ' | type: ' + TYPE_NAMES[node.type];
    tooltip += ' | id: ' + node.id;

    // 节点头部
    html += '<div class="as-tree-node as-dev-node' + (matchesSearch && devSearchText ? ' as-search-highlight' : '') + syncStateClass + '" style="padding-left:' + padLeft + 'px" title="' + escHtml(tooltip) + '">';

    // 展开/折叠
    if (canExpand) {
      html += '<span class="as-expand" data-id="' + node.id + '" style="width:16px;display:inline-block;text-align:center;cursor:pointer">';
      html += isExpanded ? '\u25BC' : '\u25B6';
      html += '</span>';
    } else {
      html += '<span style="width:16px;display:inline-block"></span>';
    }

    // checkbox
    var cbClass = 'as-cb';
    if (checkedState === 'indeterminate') cbClass += ' as-cb-partial';
    html += '<input type="checkbox" class="' + cbClass + '" data-id="' + node.id + '" ' + (checkedState === 'checked' ? 'checked' : '') + '>';

    // 图标 + 名称
    var icon = TYPE_ICONS[node.type] || '\uD83D\uDCC4';
    html += '<span class="as-node-label" style="cursor:pointer">' + icon + ' ' + escHtml(node.name || node.code || '(空)') + '</span>';

    // 状态标记
    if (node.status === 1) html += ' <span style="color:#ff4d4f;font-size:10px">[\u505C\u7528]</span>';

    // 类型标记
    html += ' <span class="as-type-tag">' + TYPE_NAMES[node.type] + '</span>';

    // 权限字符（按钮节点）
    if (node.type === TYPE_BTN && node.perms) {
      html += ' <span class="as-perms-tag">' + escHtml(node.perms) + '</span>';
    }

    html += '</div>';

    // 子节点
    if (canExpand && isExpanded) {
      if (hasChildren) {
        node.children.forEach(function (c) {
          html += renderDevNode(c, depth + 1, childTargetParentId);
        });
      }
      if (hasDetails) {
        node.resourceDetailList.forEach(function (d, idx) {
          html += '<div class="as-tree-node as-detail-node" style="padding-left:' + (padLeft + 18) + 'px">';
          html += '<span style="width:16px;display:inline-block"></span>';
          html += '<input type="checkbox" class="as-cb" data-id="' + d.id + '" ' + (d._sel ? 'checked' : '') + ' style="visibility:hidden">';
          html += '<span class="as-node-label">\uD83D\uDCC4 ' + escHtml(d.name || d.code || '明细#' + (idx + 1)) + '</span>';
          html += '</div>';
        });
      }
    }

    return html;
  }

  function anyNodeMatchesSearch(node, search) {
    if (nodeMatchesSearch(node, search)) return true;
    if (node.children) {
      return node.children.some(function (c) { return anyNodeMatchesSearch(c, search); });
    }
    return false;
  }

  function nodeMatchesSearch(node, search) {
    if (!search) return true;
    var haystack = (node.name + ' ' + node.code + ' ' + node.perms + ' ' + node.path + ' ' + TYPE_NAMES[node.type]).toLowerCase();
    return haystack.indexOf(search) !== -1;
  }

  function renderTestTree() {
    var el = document.getElementById('as-test-tree');
    if (!el) return;
    var html = '';
    testTree.forEach(function (n) {
      html += renderTestNode(n, 0);
    });
    el.innerHTML = html || '<div class="as-empty">点击「采集目标数据」拉取数据</div>';

    var cntEl = document.getElementById('as-test-count');
    if (cntEl) cntEl.textContent = countNodes(testTree);
  }

  function renderTestNode(node, depth) {
    var hasChildren = node.children && node.children.length > 0;
    var canExpand = hasChildren;
    var isExpanded = expandedTest[String(node.id)] === true;
    var isSelected = String(node.id) === String(selectedTestNodeId);
    var matchesSearch = !testSearchText || nodeMatchesSearch(node, testSearchText);

    if (testSearchText && !matchesSearch) {
      if (hasChildren) {
        var childMatch = node.children.some(function (c) { return anyNodeMatchesSearch(c, testSearchText); });
        if (!childMatch) return '';
      } else return '';
    }

    var html = '';
    var padLeft = depth * 18;

    var tip = node.name || '(空)';
    if (node.path) tip += ' | path: ' + node.path;
    tip += ' | type: ' + TYPE_NAMES[node.type];

    html += '<div class="as-tree-node as-test-node' + (isSelected ? ' as-test-selected' : '') + (matchesSearch && testSearchText ? ' as-search-highlight' : '') + '" data-id="' + node.id + '" style="padding-left:' + padLeft + 'px;cursor:pointer" title="' + escHtml(tip) + '">';

    if (canExpand) {
      html += '<span class="as-expand" data-id="' + node.id + '" style="width:16px;display:inline-block;text-align:center;cursor:pointer;color:#888">';
      html += isExpanded ? '\u25BC' : '\u25B6';
      html += '</span>';
    } else {
      html += '<span style="width:16px;display:inline-block"></span>';
    }

    var icon = TYPE_ICONS[node.type] || '\uD83D\uDCC4';
    html += '<span class="as-node-label">' + icon + ' ' + escHtml(node.name || node.code || '(空)') + '</span>';

    if (node.status === 1) html += ' <span style="color:#ff4d4f;font-size:10px">[\u505C\u7528]</span>';

    html += ' <span class="as-type-tag">' + TYPE_NAMES[node.type] + '</span>';

    if (isSelected) {
      html += ' <span style="color:#1890ff;font-size:16px;margin-left:auto">\u2714</span>';
    }

    html += '</div>';

    if (canExpand && isExpanded) {
      node.children.forEach(function (c) {
        html += renderTestNode(c, depth + 1);
      });
    }

    return html;
  }

  function renderQueue() {
    var el = document.getElementById('as-queue-list');
    var cntEl = document.getElementById('as-queue-count');
    if (!el) return;

    if (syncMode === 'single') {
      if (cntEl) cntEl.textContent = singleTasks.length;
      var html = '';
      singleTasks.forEach(function (t, i) {
        var icon = TYPE_ICONS[t.sourceNode.type] || '\uD83D\uDCC4';
        html += '<div class="as-queue-item">';
        html += '<span style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">';
        html += '<span class="as-task-expand" style="visibility:hidden;width:14px;flex-shrink:0"></span>';
        html += '<span style="font-size:11px;overflow:hidden;text-overflow:ellipsis" class="as-sync-update">' + icon + ' <b>' + escHtml(t.sourceNode.name) + '</b></span>';
        html += '<span style="color:#bbb;font-size:9px;flex-shrink:0">\u2192</span>';
        html += '<span style="font-size:10px;color:#888;overflow:hidden;text-overflow:ellipsis">' + escHtml(t.targetNodeName) + '</span>';
        html += '</span>';
        html += '<span class="as-task-del" data-idx="' + i + '" title="\u79FB\u9664">\u2715</span>';
        html += '</div>';
      });
      if (singleTasks.length === 0) {
        html = '<div class="as-empty" style="padding:10px">\u6682\u65E0\u4EFB\u52A1\uFF0C\u52FE\u9009\u6E90\u8282\u70B9\u5E76\u9009\u62E9\u76EE\u6807\u8282\u70B9</div>';
      }
      el.innerHTML = html;
      // 重新绑定删除
      el.querySelectorAll('.as-task-del').forEach(function (btn) {
        btn.onclick = function () {
          var idx = parseInt(this.getAttribute('data-idx'), 10);
          singleTasks.splice(idx, 1);
          saveStoredData();
          refreshPanel();
        };
      });
      return;
    }

    if (cntEl) cntEl.textContent = syncTasks.length;

    var html = '';
    syncTasks.forEach(function (t, i) {
      var icon = TYPE_ICONS[t.sourceNode.type] || '\uD83D\uDCC4';
      var childrenCount = t.sourceChildren.length;
      var expanded = expandedQueue[i] === true;
      var states = computeTaskStates(t);
      var rootState = states[String(t.sourceNode.id)];

      html += '<div class="as-queue-item">';
      html += '<span style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">';
      html += '<span class="as-task-expand" data-idx="' + i + '" style="cursor:pointer;font-size:10px;color:#999;flex-shrink:0;width:14px;text-align:center">' + (expanded ? '\u25BC' : '\u25B6') + '</span>';
      html += '<span style="font-size:11px;overflow:hidden;text-overflow:ellipsis" class="' + (rootState === 'update' ? 'as-sync-update' : (rootState === 'new' ? 'as-sync-new' : '')) + '">' + icon + ' <b>' + escHtml(t.sourceNode.name) + '</b></span>';
      if (childrenCount > 0) html += '<span style="color:#1890ff;font-size:10px;flex-shrink:0"> +' + childrenCount + '\u5B50</span>';
      html += '<span style="color:#bbb;font-size:9px;flex-shrink:0">\u2192</span>';
      html += '<span style="font-size:10px;color:#888;overflow:hidden;text-overflow:ellipsis">' + escHtml(t.targetParentName) + '</span>';
      html += '</span>';
      html += '<span class="as-task-del" data-idx="' + i + '" title="\u79FB\u9664">\u2715</span>';
      html += '</div>';

      // 展开显示子节点
      if (expanded && childrenCount > 0) {
        html += '<div class="as-queue-children">';
        t.sourceChildren.forEach(function (c) {
          var cIcon = TYPE_ICONS[c.type] || '\uD83D\uDCC4';
          var cState = states[String(c.id)];
          var cTag = cState === 'update' ? '\u672C\u6B21\u66F4\u65B0' : (cState === 'new' ? '\u672C\u6B21\u65B0\u589E' : (cState === 'none' ? '\u65E0\u9700\u66F4\u65B0' : ''));
          html += '<div class="as-queue-child"><span class="' + (cState === 'update' ? 'as-sync-update' : (cState === 'new' ? 'as-sync-new' : '')) + '">' + cIcon + ' ' + escHtml(c.name || '') + '</span>' + (cTag ? '<span style="font-size:9px;color:#888;margin-left:4px">' + cTag + '</span>' : '') + '</div>';
        });
        html += '</div>';
      }
    });

    if (syncTasks.length === 0) {
      html = '<div class="as-empty" style="padding:10px">\u6682\u65E0\u4EFB\u52A1\uFF0C\u8BF7\u52FE\u9009\u6E90\u8282\u70B9\u5E76\u9009\u62E9\u76EE\u6807\u4F4D\u7F6E</div>';
    }

    el.innerHTML = html;
  }

  // 计算队列任务中每个节点的同步状态（new=新增/update=更新）
  function computeTaskStates(task) {
    var states = {};
    var source = task.sourceNode;
    var targetId = task.targetParentId;
    var idMap = {};

    var bfsQueue = [source];
    for (var i = 0; i < bfsQueue.length; i++) {
      var node = bfsQueue[i];
      var parentId;
      if (String(node.id) === String(source.id)) {
        parentId = targetId;
      } else {
        parentId = idMap[String(node._parentId || node.parentId)] || targetId;
      }
      var existing = findInTarget(parentId, node);
      if (existing) {
        if (nodesEqual(existing, node)) {
          states[String(node.id)] = 'none'; // 字段一致，无需更新
        } else {
          states[String(node.id)] = 'update';
        }
        idMap[String(node.id)] = existing.id;
      } else {
        states[String(node.id)] = 'new';
      }
      if (node.children) {
        node.children.forEach(function (c) {
          if (c._sel) { c._parentId = node.id; bfsQueue.push(c); }
        });
      }
    }
    return states;
  }

  function renderLog() {
    var logEl = document.getElementById('as-log');
    var logWrap = document.getElementById('as-log-wrap');
    var logCount = document.getElementById('as-log-count');
    if (!logEl || !logWrap) return;

    if (syncLog.length > 0) {
      logEl.innerHTML = syncLog.map(function (l) {
        var cls = l.type === 'success' || l.type === 'ok' ? 'success' : l.type === 'warn' || l.type === 'skip' ? 'warn' : l.type === 'error' || l.type === 'err' ? 'error' : 'info';
        return '<div class="as-log-item as-log-' + cls + '">[' + l.time + '] ' + escHtml(l.msg) + '</div>';
      }).join('');
      if (logCount) logCount.textContent = syncLog.length + ' 条';
      logWrap.style.display = '';
    } else {
      logWrap.style.display = 'none';
    }
  }

  function refreshPanel() {
    if (!panelEl) return;

    var body = document.getElementById('as-body');
    if (body) {
      body.style.display = isPanelOpen ? 'flex' : 'none';
      if (isPanelOpen) {
        // 动态高度：窗口高度的80%
        body.style.height = Math.floor(window.innerHeight * 0.8) + 'px';
      }
    }

    var badge = document.getElementById('as-badge');
    if (badge) {
      var total = countNodes(devTree) + countNodes(testTree);
      if (total > 0) { badge.style.display = 'flex'; badge.textContent = total; }
      else { badge.style.display = 'none'; }
    }

    // 当前环境标签
    var envEl = document.getElementById('as-current-env');
    if (envEl) {
      var host = window.location.hostname;
      envEl.textContent = host;
      envEl.style.color = host.indexOf('dev') !== -1 ? '#1890ff' : (host.indexOf('test') !== -1 ? '#52c41a' : '#888');
    }

    addParentIdArr(devTree);
    addParentIdArr(testTree);
    renderDevTree();
    renderTestTree();
    renderQueue();
    updateTargetInfo();
    renderLog();
    renderUserPane();

    // 模式按钮高亮
    var mode0 = document.getElementById('as-mode-batch');
    var mode1 = document.getElementById('as-mode-single');
    if (mode0) { mode0.classList.toggle('as-mode-active', syncMode === 'batch'); mode0.style.background = syncMode === 'batch' ? '#1890ff' : ''; mode0.style.color = syncMode === 'batch' ? '#fff' : '#666'; }
    if (mode1) { mode1.classList.toggle('as-mode-active', syncMode === 'single'); mode1.style.background = syncMode === 'single' ? '#faad14' : ''; mode1.style.color = syncMode === 'single' ? '#fff' : '#666'; }

    // 按钮状态
    var execBtn = document.getElementById('as-exec-sync');
    var total = syncMode === 'single' ? singleTasks.length : syncTasks.length;
    if (execBtn) {
      execBtn.disabled = syncStatus === 'syncing';
      execBtn.textContent = syncStatus === 'syncing' ? '\u23F3 \u540C\u6B65\u4E2D...' : ('\uD83D\uDCE4 \u6267\u884C\u961F\u5217 (' + total + ')');
    }

    // 单点/批量按钮显示切换
    var addBtn = document.getElementById('as-add-queue');
    var updBtn = document.getElementById('as-update-single');
    if (addBtn) addBtn.style.display = syncMode === 'single' ? 'none' : '';
    if (updBtn) updBtn.style.display = syncMode === 'single' ? '' : 'none';

    // 目标信息提示
    var infoEl = document.getElementById('as-target-info');
    if (infoEl && !selectedTestNodeId) {
      if (syncMode === 'single') {
        infoEl.innerHTML = '\uD83D\uDC46 \u5355\u70B9\u6A21\u5F0F\uFF1A\u70B9\u51FB\u9009\u62E9\u76EE\u6807\u8282\u70B9\uFF0C\u6E90\u8282\u70B9\u5C06\u76F4\u63A5\u66F4\u65B0\u5230\u8BE5\u8282\u70B9';
      } else {
        infoEl.innerHTML = '\uD83D\uDC46 \u6279\u91CF\u6A21\u5F0F\uFF1A\u70B9\u51FB\u9009\u62E9\u76EE\u6807\u7236\u8282\u70B9';
      }
      infoEl.style.color = '#888';
    }
  }

  function disableButtons(disabled) {
    ['as-capture-dev', 'as-capture-test', 'as-exec-sync', 'as-add-queue'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
  }

  function pulseToggle() {
    var toggle = document.getElementById('as-toggle');
    if (toggle) { toggle.classList.add('as-pulse'); setTimeout(function () { toggle.classList.remove('as-pulse'); }, 1000); }
  }

  // ==================== 拖拽 ====================
  function setupDrag() {
    var toggle = document.getElementById('as-toggle');
    if (!toggle) return;

    var dragging = false, moved = false;
    var startX, startY, startRight, startBottom;
    var DRAG_THRESHOLD = 3;

    toggle.addEventListener('click', function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    try {
      var saved = localStorage.getItem('auth_sync_pos');
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
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
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
      try {
        localStorage.setItem('auth_sync_pos', JSON.stringify({
          right: parseInt(panelEl.style.right) || 20,
          bottom: parseInt(panelEl.style.bottom) || 20
        }));
      } catch (e) {}
    });
  }

  // ==================== 面板宽度拖拽 ====================
  function setupResizeHandle() {
    var handle = document.getElementById('as-resize-handle');
    var body = document.getElementById('as-body');
    if (!handle || !body) return;

    var dragging = false, startX, startWidth;

    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startWidth = body.offsetWidth;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var dx = startX - e.clientX;
      var newWidth = Math.max(500, Math.min(startWidth + dx, window.innerWidth - 100));
      body.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      try {
        localStorage.setItem('auth_sync_panel_width', body.style.width);
      } catch (e) {}
    });

    // 恢复上次宽度
    try {
      var saved = localStorage.getItem('auth_sync_panel_width');
      if (saved) body.style.width = saved;
    } catch (e) {}
  }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ==================== 外部消息 ====================
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'GET_STATUS') {
      sendResponse({
        devNodeCount: countNodes(devTree),
        testNodeCount: countNodes(testTree),
        taskCount: syncTasks.length,
        syncStatus: syncStatus
      });
    }
    return true;
  });

  // ==================== 启动 ====================
  init();
})();