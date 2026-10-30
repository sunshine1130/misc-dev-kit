/**
 * Dict Sync - 环境闸（EnvGuard）
 *
 * 职责只有一个：回答「这个域名现在允许写吗」以及「为什么不允许」。
 * 不碰 DOM、不读存储、不发请求，因此可以用 node 直接跑单测。
 *
 * ── 为什么要把这套规则单独抽出来 ──
 * 字典同步是"往数据库写配置"，在生产环境点错一次就是真实的配置事故，
 * 而它又是**默认到处都能跑**的（manifest 里 matches 是 <all_urls>），
 * 所以"能不能写"必须由纯规则决定，而不是散落在各个按钮的点击回调里。
 *
 * ── 与 auth-resource-sync/perm-map.js 的关系（重要）──
 * 这两个扩展各自独立加载，没有构建步骤，没法共享同一个文件，因此规则是
 * **两份实现**。一致性由 dict-sync/tests/env-guard-consistency.test.cjs 保证：
 * 它同时加载两份实现，对同一批域名断言判定结果、环境标签、颜色完全一致。
 * 改这里的白名单/标签，必须同步改那边，否则那个测试会红。
 *
 * ── 关键业务边界 ──
 *   1. 白名单按**宿主首段**判断（dev/test/sit/uat），不匹配即只读。
 *      未知域名一律只读 —— 默认拒绝，而不是默认放行，这是刻意的。
 *   2. uat 属于可写的测试环境（用户确认：改错可以重来），只挡生产。
 *   3. 生产不带环境前缀，形如 auth.joyintoy.cn / www.joyintoy.cn。
 *   4. 文案必须如实反映环境类型，不能把 uat/stg 一律叫"生产"。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.EnvGuard = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ==================== 颜色 ====================
  // 逐字照抄 auth-resource-sync/perm-map.js：同一个环境在两个扩展里必须是同一个
  // 颜色，否则同事在两边来回看还要重新学一遍配色。**顺序也有意义**（先匹配先返回），
  // 且只列了四类；sit 之类不在表里，落到下面的哈希兜底色 —— 这是原样保留的行为，
  // 不要"顺手补全"，那会让两个扩展的同一域名显示成不同颜色。
  var ENV_FIXED_COLORS = [
    { re: /prod|prd/i, color: '#cf1322' },        // 生产：红
    { re: /uat|stg|staging/i, color: '#fa8c16' }, // 预发：橙
    { re: /test/i, color: '#389e0d' },            // 测试：绿
    { re: /dev/i, color: '#1890ff' }              // 开发：蓝
  ];
  var ENV_FALLBACK_COLORS = ['#722ed1', '#eb2f96', '#13c2c2', '#2f54eb', '#a0d911', '#f5222d'];

  function envColor(host) {
    host = String(host || '');
    for (var i = 0; i < ENV_FIXED_COLORS.length; i++) {
      if (ENV_FIXED_COLORS[i].re.test(host)) return ENV_FIXED_COLORS[i].color;
    }
    var h = 0;
    for (var j = 0; j < host.length; j++) h = (h * 31 + host.charCodeAt(j)) >>> 0;
    return ENV_FALLBACK_COLORS[h % ENV_FALLBACK_COLORS.length];
  }

  function shortEnv(host) {
    var s = String(host || '');
    return s ? s.split('.')[0] : '';
  }

  // ==================== 可写判定 ====================
  var WRITABLE_LABEL_RE = /(dev|test|sit|uat)/i;

  function isLocal(host) {
    return host === 'localhost' || host.indexOf('localhost') === 0 ||
           host === '127.0.0.1' || host.indexOf('127.0.0.1') === 0;
  }

  function isWriteAllowed(host) {
    host = String(host || '').toLowerCase();
    if (!host) return false;
    if (isLocal(host)) return true;
    return WRITABLE_LABEL_RE.test(host.split('.')[0]);
  }

  // 生产域的判定：公司主域下**不带环境标记**的宿主就是生产。
  // 不能靠硬编码域名清单 —— 原先只认 auth/www，结果 zt.joyintoy.cn（用户确认是生产）
  // 落进了"未知环境"：安全上没错（照样只读），但文案会误导：看到"未知"的人会以为
  // 插件不认识这个域名、跑去翻白名单，而不是明白"这是生产，别写"。
  // 顺序要紧：必须先排掉带环境标记的（mdmdev-auth / uat-zt / test-zt …），
  // 否则它们会被误判成生产。
  var PROD_DOMAIN_RE = /(^|\.)joyintoy\.cn$/i;
  var ENV_LABELS = [
    { re: /prod|prd/i, label: '生产' },
    { re: /stg|staging/i, label: '预发' },
    { re: /uat/i, label: '验收测试' },
    { re: /sit/i, label: '集成测试' },
    { re: /test/i, label: '测试' },
    { re: /dev/i, label: '开发' }
  ];

  function envLabel(host) {
    host = String(host || '');
    if (!host) return '未知';
    if (isLocal(host)) return '本地';
    var head = host.split('.')[0];
    for (var i = 0; i < ENV_LABELS.length; i++) {
      if (ENV_LABELS[i].re.test(head)) return ENV_LABELS[i].label;
    }
    if (PROD_DOMAIN_RE.test(host)) return '生产';
    return '未知';
  }

  /** 供界面展示：为什么这个环境不允许写；可写时返回空串 */
  function writeBlockReason(host) {
    if (isWriteAllowed(host)) return '';
    var h = String(host || '未知环境');
    // 不逐个列举可写环境：那是会随白名单调整而漂移的信息，说"开发/测试类"即可
    return '「' + h + '」是' + envLabel(h) + '环境，默认只读、禁止写入。' +
           '只有开发/测试类环境允许写入；确有需要可在面板头部点「开启写入」临时豁免。';
  }

  // ==================== 写接口识别 ====================
  /**
   * 判断一个接口路径是不是"会改数据"的。
   *
   * 为什么必须有这层：dict-sync 的 inject 代理**永远用 POST**，读写区分不了，
   * 所以不能按 HTTP method 判断，只能按路径。这层是兜底 —— 就算以后有人在
   * 别处直接调 callApi，只要路径像写接口就仍然会被拦下。
   *
   * 已知只读：/base/dictType/listPage、/base/dictData/listPage
   * 已知写入：/base/dictType/add、/base/dictType/edit、
   *          /base/dictData/add、/base/dictData/edit
   *
   * 局限（改代码时注意）：靠动词子串匹配，新增的写接口若不含下列动词会被漏判。
   * 所以新增接口时，**必须同时在 tests/env-guard.test.cjs 里加一条断言**把分类钉住。
   */
  var WRITE_VERB_RE = /(add|edit|update|save|delete|remove|create|modify|import|submit)/i;

  function isWritePath(apiPath) {
    var p = String(apiPath || '').split('?')[0];
    if (!p) return false;
    return WRITE_VERB_RE.test(p);
  }

  return {
    envColor: envColor,
    shortEnv: shortEnv,
    envLabel: envLabel,
    isWriteAllowed: isWriteAllowed,
    writeBlockReason: writeBlockReason,
    isWritePath: isWritePath,
    WRITABLE_LABEL_RE: WRITABLE_LABEL_RE,
    PROD_DOMAIN_RE: PROD_DOMAIN_RE
  };
});
