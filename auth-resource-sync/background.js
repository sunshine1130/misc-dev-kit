/**
 * Auth Resource Sync - Background Service Worker
 *
 * 这里只保留一个职责：执行「清空全部数据」。
 *
 * 为什么由 background 独占这个动作，而不是让 popup 自己 remove：
 *   storage 一旦被清空，已打开页面的 content script 会通过 onChanged 重置内存状态。
 *   若 popup 与 background 各有一条清除路径，两边行为容易各自演化（曾经就出过
 *   "popup 清空了存储、面板却还显示旧数据"的问题）。集中到一处，行为只有一个来源。
 *
 * 注意：不要在响应里返回存储的默认结构 —— 之前有个 GET_DATA 处理器返回的默认
 * 结构不带 srcSnapshot/tgtSnapshot/devHost/testHost，是过期的，已删除。
 */
var STORAGE_KEY = 'auth_resource_sync_data';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'CLEAR_DATA') {
    chrome.storage.local.remove(STORAGE_KEY).then(function () {
      sendResponse({ success: true });
    }).catch(function (e) {
      sendResponse({ success: false, error: e && e.message });
    });
    return true;   // 异步响应，必须保持通道打开
  }
  return false;
});
