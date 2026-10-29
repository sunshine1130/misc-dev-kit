/**
 * FBA分段匹配工具 - Content Script
 *
 * 方案：
 *  1. 主世界注入脚本，包裹 XMLHttpRequest / fetch，直接捕获页面 axios 请求
 *     已成功返回的 FBA 配置接口数据（自动携带正确 URL + Authorization 等 header）。
 *  2. 若缓存为空（页面在扩展安装前已加载好），则用「学到的 API host 或默认
 *     https://mdmdev-api.joyintoy.cn」+ localStorage 里的 Admin-Token 主动请求兜底。
 */
;(function () {
  'use strict'

  // ==================== 主世界注入脚本 ====================
  const INJECTED_SOURCE = `
;(function () {
  if (window.__FBA_CAPTURE_INSTALLED__) return
  window.__FBA_CAPTURE_INSTALLED__ = true

  var SIZE_LIST_URL = '/pms/fba/sizeSegment/list'
  var WEIGHT_LIST_URL = '/pms/fba/weightSegment/list'
  var WEIGHT_DETAIL_URL = '/pms/fba/weightSegment/getBySizeSegmentId'

  function post(type, data) {
    try { window.postMessage({ __fba: true, type: type, data: data }, '*') } catch (e) {}
  }

  // 从任意 /pms/ 请求学习 API baseURL（提取 origin），供兜底主动请求使用
  function learnBase(url) {
    try {
      if (url.indexOf('/pms/') !== -1 && /^https?:\\/\\//.test(url)) {
        var u = new URL(url, window.location.origin)
        post('FBA_LEARN_BASE', u.origin)
      }
    } catch (e) {}
  }

  function tryJson(text) {
    try { return JSON.parse(text) } catch (e) { return null }
  }

  function handleSizeList(text) {
    var j = tryJson(text)
    if (j && j.code === 200 && j.data) post('FBA_SIZE_LIST', j.data)
  }
  function handleWeightList(text) {
    var j = tryJson(text)
    if (j && j.code === 200 && j.data) post('FBA_WEIGHT_LIST', j.data)
  }
  function handleWeightDetail(url, text) {
    var j = tryJson(text)
    if (j && j.code === 200 && j.data) post('FBA_WEIGHT_DETAIL', { url: url, data: j.data })
  }

  function dispatchUrlText(url, text) {
    if (!url || !text) return
    learnBase(url)
    if (url.indexOf(SIZE_LIST_URL) !== -1) handleSizeList(text)
    else if (url.indexOf(WEIGHT_DETAIL_URL) !== -1) handleWeightDetail(url, text)
    else if (url.indexOf(WEIGHT_LIST_URL) !== -1) handleWeightList(text)
  }

  // ---- 包裹 XMLHttpRequest ----
  var XHR = window.XMLHttpRequest
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open
    var origSend = XHR.prototype.send
    XHR.prototype.open = function (method, url) {
      this.__fbaUrl = typeof url === 'string' ? url : ''
      return origOpen.apply(this, arguments)
    }
    XHR.prototype.send = function () {
      var self = this
      this.addEventListener('load', function () {
        dispatchUrlText(self.__fbaUrl || '', self.responseText || '')
      })
      return origSend.apply(this, arguments)
    }
  }

  // ---- 包裹 fetch ----
  var origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var p = origFetch.apply(this, arguments)
      var u = typeof input === 'string' ? input : (input && input.url) || ''
      if (typeof p === 'object' && p && typeof p.then === 'function') {
        p.then(function (response) {
          if (response && typeof response.clone === 'function') {
            response.clone().text().then(function (t) {
              dispatchUrlText(u, t)
            }).catch(function () {})
          }
          return response
        })
      }
      return p
    }
  }
})();
`

  function injectScript(source) {
    const script = document.createElement('script')
    script.textContent = source
    ;(document.head || document.documentElement).appendChild(script)
    script.remove()
  }

  function tryInject() {
    if (document.head || document.documentElement) {
      injectScript(INJECTED_SOURCE)
    } else {
      const onReady = () => {
        injectScript(INJECTED_SOURCE)
        document.removeEventListener('readystatechange', onReady)
      }
      document.addEventListener('readystatechange', onReady)
    }
  }
  tryInject()

  // ==================== 聚合状态 ====================

  let dimWeightDivisor = null
  let sizeSegments = []
  let weightSegmentLookup = {} // { sizeSegmentId: weightSegmentList[] }
  let learnedApiBase = ''

  const DEFAULT_API_BASE = 'https://mdmdev-api.joyintoy.cn'

  /** 从当前页面 hostname 推导 API 地址: mdm{env}-zt → mdm{env}-api */
  function deriveApiBaseFromPage() {
    try {
      const hostname = window.location.hostname
      // 匹配模式: mdm{env}-zt.joyintoy.cn → mdm{env}-api.joyintoy.cn
      const apiHostname = hostname.replace(/-zt\./, '-api.')
      if (apiHostname !== hostname) {
        return 'https://' + apiHostname
      }
    } catch (e) {}
    return null
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return
    const d = event.data
    if (!d || d.__fba !== true) return

    if (d.type === 'FBA_SIZE_LIST') {
      const data = d.data || {}
      dimWeightDivisor = data.dimWeightDivisor
      sizeSegments = data.sizeSegments || []
    } else if (d.type === 'FBA_WEIGHT_LIST') {
      const list = d.data || []
      list.forEach(function (item) {
        if (item && item.sizeSegmentId != null && !weightSegmentLookup[item.sizeSegmentId]) {
          weightSegmentLookup[item.sizeSegmentId] = []
        }
      })
    } else if (d.type === 'FBA_WEIGHT_DETAIL') {
      const url = d.url || ''
      const data = d.data || {}
      const m = url.match(/sizeSegmentId=([^&]+)/)
      if (m && m[1]) {
        const id = decodeURIComponent(m[1])
        weightSegmentLookup[id] = data.weightSegmentList || []
      }
    } else if (d.type === 'FBA_LEARN_BASE') {
      if (d.data && !learnedApiBase) learnedApiBase = d.data
    }
  })

  // ==================== 主动请求兜底（委托 background，豁免 CORS） ====================

  function getApiBase() {
    return learnedApiBase || deriveApiBaseFromPage() || DEFAULT_API_BASE
  }

  function getAuthInfo() {
    const token = localStorage.getItem('Admin-Token')
    const lang = localStorage.getItem('lang') || 'zh-CN'
    let tz = 'Asia/Shanghai'
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    } catch (e) {}
    return { token, lang, tz }
  }

  /** 通过 background service worker 发请求（跨域豁免 CORS） */
  async function fetchJson(url) {
    const { token, lang, tz } = getAuthInfo()
    const resp = await chrome.runtime.sendMessage({
      action: 'fbaFetch',
      url,
      token,
      lang,
      tz
    })
    if (!resp || !resp.success) {
      throw new Error(resp?.error || '请求失败')
    }
    return resp.data
  }

  async function activeReadAll() {
    const base = getApiBase()
    const sizeData = await fetchJson(base + '/pms/fba/sizeSegment/list')
    dimWeightDivisor = sizeData.dimWeightDivisor
    sizeSegments = sizeData.sizeSegments || []

    const lookup = {}
    try {
      const weightList = await fetchJson(base + '/pms/fba/weightSegment/list')
      for (const item of weightList || []) {
        if (item && item.sizeSegmentId != null) {
          try {
            const detail = await fetchJson(
              base + '/pms/fba/weightSegment/getBySizeSegmentId?sizeSegmentId=' +
                encodeURIComponent(item.sizeSegmentId)
            )
            lookup[item.sizeSegmentId] = detail.weightSegmentList || []
          } catch (e) {
            lookup[item.sizeSegmentId] = []
          }
        }
      }
    } catch (e) {
      console.warn('[FBA匹配工具] 获取重量分段失败:', e.message)
    }
    weightSegmentLookup = lookup
  }

  // ==================== 与 popup 通信 ====================

  function buildConfig() {
    return {
      dimWeightDivisor,
      sizeSegments,
      weightSegmentLookup,
      readAt: new Date().toISOString(),
      origin: window.location.origin,
      apiBase: getApiBase()
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ pong: true })
      return true
    }

    if (request.action === 'readFbaConfig') {
      handleReadConfig()
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }))
      return true
    }
  })

  async function handleReadConfig() {
    // 1. 优先用已捕获的缓存
    if (sizeSegments && sizeSegments.length > 0) {
      return buildConfig()
    }

    // 2. 缓存为空 → 主动请求兜底
    await activeReadAll()
    if (sizeSegments && sizeSegments.length > 0) {
      return buildConfig()
    }
    throw new Error('未能读取到配置，请确认已登录 PMS 且当前有 FBA 参数配置权限')
  }
})()