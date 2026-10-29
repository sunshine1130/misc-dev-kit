/**
 * 帮助页脚本：只做一件事 —— 把扩展自身版本号填进页脚。
 *
 * 为什么单独一个文件：MV3 扩展页默认 CSP 是 script-src 'self'，
 * 内联 <script> 会被直接拦掉，所以必须放独立文件并用 <script src> 引用。
 *
 * 为什么不在 HTML 里写死：写死的 "v1.1" 到 1.5.x 时早就和 manifest 对不上了，
 * 同事看到的是个假的版本号 —— 这种"手抄一份状态"的写法迟早会漂移。
 */
(function () {
  'use strict';
  try {
    var el = document.getElementById('help-version');
    if (el) el.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    /* 用文件方式直接打开 help.html 时没有扩展 API，忽略即可 */
  }
})();
