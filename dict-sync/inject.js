/**
 * Dict Sync - Page-world injected script
 * 功能：
 *   1. 拦截 XHR/fetch 响应，捕获字典相关 API 数据
 *   2. 代理 content script 的 API 调用（避免 CORS/Origin 问题）
 */
(function () {
  'use strict';

  // 要拦截的 API 路径
  const DICT_LIST_API = '/base/dictType/listPage';
  const DICT_VALUE_LIST_API = '/base/dictData/listPage';

  // 缓存最近的 API 响应
  var cachedResponses = {
    dictList: null,
    dictValueList: null
  };

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

    self.addEventListener('load', function () {
      if (!url) return;

      try {
        var responseData = JSON.parse(self.responseText);

        if (url.indexOf(DICT_LIST_API) !== -1 && responseData.code === 200) {
          cachedResponses.dictList = {
            timestamp: Date.now(),
            url: url,
            data: responseData.data
          };
          window.postMessage({
            source: 'dict-sync-inject',
            type: 'DICT_LIST_CAPTURED',
            payload: cachedResponses.dictList
          }, '*');
        }

        if (url.indexOf(DICT_VALUE_LIST_API) !== -1 && responseData.code === 200) {
          var dictTypeId = '';
          try {
            if (body && typeof body === 'string') {
              var parsed = JSON.parse(body);
              dictTypeId = parsed.dictTypeId || '';
            }
          } catch (e) { /* ignore */ }

          cachedResponses.dictValueList = {
            timestamp: Date.now(),
            url: url,
            dictTypeId: dictTypeId,
            data: responseData.data
          };
          window.postMessage({
            source: 'dict-sync-inject',
            type: 'DICT_VALUE_LIST_CAPTURED',
            payload: cachedResponses.dictValueList
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

        if (url.indexOf(DICT_LIST_API) !== -1 || url.indexOf(DICT_VALUE_LIST_API) !== -1) {
          clonedResponse.json().then(function (data) {
            if (data.code === 200) {
              if (url.indexOf(DICT_LIST_API) !== -1) {
                cachedResponses.dictList = { timestamp: Date.now(), url: url, data: data.data };
                window.postMessage({
                  source: 'dict-sync-inject',
                  type: 'DICT_LIST_CAPTURED',
                  payload: cachedResponses.dictList
                }, '*');
              }
              if (url.indexOf(DICT_VALUE_LIST_API) !== -1) {
                var dictTypeId = '';
                try {
                  if (init && init.body && typeof init.body === 'string') {
                    dictTypeId = JSON.parse(init.body).dictTypeId || '';
                  }
                } catch (e) { /* ignore */ }
                cachedResponses.dictValueList = {
                  timestamp: Date.now(), url: url, dictTypeId: dictTypeId, data: data.data
                };
                window.postMessage({
                  source: 'dict-sync-inject',
                  type: 'DICT_VALUE_LIST_CAPTURED',
                  payload: cachedResponses.dictValueList
                }, '*');
              }
            }
          }).catch(function () {});
        }
      } catch (e) { /* ignore */ }

      return response;
    });
  };

  // ==================== API 代理：在页面上下文发起请求 ====================
  /**
   * 从页面上下文调用 API
   * 使用页面的 origin + cookie/auth，完全避免 CORS 问题
   */
  function proxyApiCall(apiPath, data, token) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', apiPath, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (token) {
        xhr.setRequestHeader('Authorization', token);
      }
      xhr.setRequestHeader('Language', localStorage.getItem('lang') || 'zh-CN');
      xhr.setRequestHeader('Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');

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
    // 只接受来自同窗口的消息
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'dict-sync-content') return;

    var msg = event.data;
    var requestId = msg.requestId;

    // 返回缓存数据
    if (msg.type === 'GET_CACHED_DATA') {
      window.postMessage({
        source: 'dict-sync-inject',
        type: 'CACHED_DATA_RESPONSE',
        requestId: requestId,
        payload: {
          dictList: cachedResponses.dictList,
          dictValueList: cachedResponses.dictValueList
        }
      }, '*');
    }

    // 代理 API 调用
    if (msg.type === 'CALL_API') {
      var apiPath = msg.apiPath;
      var data = msg.data || {};
      var token = msg.token || '';

      proxyApiCall(apiPath, data, token).then(function (result) {
        window.postMessage({
          source: 'dict-sync-inject',
          type: 'CALL_API_RESULT',
          requestId: requestId,
          success: true,
          data: result
        }, '*');
      }).catch(function (err) {
        window.postMessage({
          source: 'dict-sync-inject',
          type: 'CALL_API_RESULT',
          requestId: requestId,
          success: false,
          error: err.message
        }, '*');
      });
    }
  });

  console.log('[Dict Sync] Injected script loaded');
})();