/**
 * FBA分段匹配工具 - Background Service Worker
 * 用扩展上下文发起跨域请求（host_permissions 豁免 CORS），
 * content script 通过 chrome.runtime.sendMessage 委托到这里请求接口。
 */
;(function () {
  'use strict'

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'fbaFetch') {
      doFetch(request)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }))
      return true // 异步响应
    }
  })

  async function doFetch(request) {
    const { url, token, lang, tz } = request
    const headers = {
      Authorization: token ? 'Bearer ' + token : '',
      Language: lang || 'zh-CN',
      Timezone: tz || 'Asia/Shanghai',
      'Content-Type': 'application/json'
    }
    const res = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include'
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new Error(`接口返回非 JSON（HTTP ${res.status}），请确认已在 PMS 登录且有 FBA 配置权限`)
    }
    if (json.code !== 200) {
      throw new Error(`接口错误: code=${json.code}, msg=${json.msg || 'unknown'}`)
    }
    return json.data
  }
})()