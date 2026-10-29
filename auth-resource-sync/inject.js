/**
 * Auth Resource Sync - Page-world injected script
 * 功能：
 *   1. 拦截 XHR/fetch 响应，捕获资源树 API 数据
 *   2. 代理 content script 的 API 调用（避免 CORS/Origin 问题）
 */
(function () {
  'use strict';

  // 要拦截的 API 路径
  var RESOURCE_TREE_API = '/auth2/resource/resourceTreeList';

  // 缓存最近的 API 响应
  var cachedResponses = {
    resourceTree: null
  };

  // 当前页面检测到的 app 信息
  var detectedApp = null;

  // ==================== XHR 拦截 ====================
  var XHR = XMLHttpRequest.prototype;
  var origOpen = XHR.open;
  var origSend = XHR.send;

  XHR.open = function (method, url) {
    this._dictSyncUrl = url;
    return origOpen.apply(this, arguments);
  };

  XHR.send = function (body) {
    var self = this;
    var url = self._dictSyncUrl;

    // 保存请求体用于后续分析
    var requestBody = body;

    self.addEventListener('load', function () {
      if (!url) return;

      try {
        var responseData = JSON.parse(self.responseText);

        // 拦截资源树 API
        if (url.indexOf(RESOURCE_TREE_API) !== -1 && responseData.code === 200) {
          var appId = '';
          try {
            if (requestBody && typeof requestBody === 'string') {
              var parsed = JSON.parse(requestBody);
              appId = parsed.appId || '';
            }
          } catch (e) { /* ignore */ }

          cachedResponses.resourceTree = {
            timestamp: Date.now(),
            url: url,
            appId: appId,
            data: responseData.data || []
          };

          window.postMessage({
            source: 'auth-resource-sync-inject',
            type: 'RESOURCE_TREE_CAPTURED',
            payload: cachedResponses.resourceTree
          }, '*');
        }
      } catch (e) {
        // 非 JSON 响应，忽略
      }
    });

    return origSend.apply(this, arguments);
  };

  // ==================== fetch 拦截 ====================
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.apply(this, arguments).then(function (response) {
      var clonedResponse = response.clone();

      try {
        var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

        if (url.indexOf(RESOURCE_TREE_API) !== -1) {
          clonedResponse.json().then(function (data) {
            if (data.code === 200) {
              var appId = '';
              try {
                if (init && init.body && typeof init.body === 'string') {
                  appId = JSON.parse(init.body).appId || '';
                }
              } catch (e) { /* ignore */ }

              cachedResponses.resourceTree = {
                timestamp: Date.now(),
                url: url,
                appId: appId,
                data: data.data || []
              };

              window.postMessage({
                source: 'auth-resource-sync-inject',
                type: 'RESOURCE_TREE_CAPTURED',
                payload: cachedResponses.resourceTree
              }, '*');
            }
          }).catch(function () {});
        }
      } catch (e) { /* ignore */ }

      return response;
    });
  };

  // ==================== API 代理：在页面上下文发起请求 ====================
  function proxyApiCall(apiPath, data, token) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', apiPath, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (token) {
        xhr.setRequestHeader('Authorization', token);
      }
      xhr.setRequestHeader('Language', localStorage.getItem('lang') || 'zh-CN');

      try {
        xhr.setRequestHeader('Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
      } catch (e) {
        xhr.setRequestHeader('Timezone', 'Asia/Shanghai');
      }

      xhr.onload = function () {
        try {
          var result = JSON.parse(xhr.responseText);
          resolve(result);
        } catch (e) {
          resolve({ code: -1, msg: 'JSON parse error: ' + e.message, raw: xhr.responseText });
        }
      };

      xhr.onerror = function () {
        reject(new Error('Network error calling ' + apiPath));
      };

      xhr.ontimeout = function () {
        reject(new Error('Timeout calling ' + apiPath));
      };

      xhr.timeout = 30000;
      xhr.send(JSON.stringify(data));
    });
  }

  // ==================== 消息处理 ====================
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'auth-resource-sync-content') return;

    var msg = event.data;
    var requestId = msg.requestId;

    // 返回缓存数据
    if (msg.type === 'GET_CACHED_DATA') {
      window.postMessage({
        source: 'auth-resource-sync-inject',
        type: 'CACHED_DATA_RESPONSE',
        requestId: requestId,
        payload: {
          resourceTree: cachedResponses.resourceTree
        }
      }, '*');
    }

    // 主动拉取资源树
    if (msg.type === 'FETCH_RESOURCE_TREE') {
      var apiBase = msg.apiBase || '';
      var appId = msg.appId || '';
      var token = msg.token || '';

      if (!apiBase || !appId) {
        window.postMessage({
          source: 'auth-resource-sync-inject',
          type: 'FETCH_RESOURCE_TREE_RESULT',
          requestId: requestId,
          success: false,
          error: 'Missing apiBase or appId'
        }, '*');
        return;
      }

      var fullUrl = apiBase + '/auth2/resource/resourceTreeList';
      proxyApiCall(fullUrl, { appId: parseInt(appId, 10) || appId }, token).then(function (result) {
        if (result.code === 200) {
          cachedResponses.resourceTree = {
            timestamp: Date.now(),
            url: fullUrl,
            appId: appId,
            data: result.data || []
          };
        }
        window.postMessage({
          source: 'auth-resource-sync-inject',
          type: 'FETCH_RESOURCE_TREE_RESULT',
          requestId: requestId,
          success: result.code === 200,
          data: result,
          payload: cachedResponses.resourceTree
        }, '*');
      }).catch(function (err) {
        window.postMessage({
          source: 'auth-resource-sync-inject',
          type: 'FETCH_RESOURCE_TREE_RESULT',
          requestId: requestId,
          success: false,
          error: err.message
        }, '*');
      });
    }

    // 代理 API 调用（同步时使用）
    if (msg.type === 'CALL_API') {
      var apiPath = msg.apiPath;
      var data = msg.data || {};
      var token = msg.token || '';

      proxyApiCall(apiPath, data, token).then(function (result) {
        window.postMessage({
          source: 'auth-resource-sync-inject',
          type: 'CALL_API_RESULT',
          requestId: requestId,
          success: true,
          data: result
        }, '*');
      }).catch(function (err) {
        window.postMessage({
          source: 'auth-resource-sync-inject',
          type: 'CALL_API_RESULT',
          requestId: requestId,
          success: false,
          error: err.message
        }, '*');
      });
    }
  });

  console.log('[Auth Resource Sync] Injected script loaded');
})();