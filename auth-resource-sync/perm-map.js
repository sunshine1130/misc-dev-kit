/**
 * Auth Resource Sync - 用户权限（应用 + 角色）映射引擎
 *
 * 为什么单独抽一个文件：
 *   这段逻辑是本需求唯一"算错了就会写坏线上权限"的部分，且**跨环境 ID 不可复用**
 *   （dev/test/uat/prod 权限库各自独立，同一角色的 id 在不同环境必然不同）。
 *   抽成不依赖 DOM / chrome 的纯函数，就能用 node 直接跑单测，不必起浏览器。
 *
 * 适用范围：
 *   只负责"把源环境的应用+角色映射成目标环境的 id 列表，并算出与目标用户当前配置的差异"。
 *   不发请求、不碰 DOM、不读存储。
 *
 * 关键业务边界（改代码前务必读完）：
 *   1. 跨环境**只能按业务编码匹配**：应用用 appCode，角色用 appCode + roleCode。
 *      绝不按名称近似匹配 —— 名称在两个环境里重复或改写的概率远高于编码。
 *   2. 映射不到的一律进 unresolved 并跳过，**不猜测、不兜底填一个"看起来像"的**。
 *   3. 角色必须归属已选应用：角色所属应用没映射上，该角色一定落不了地，
 *      这与页面 handleAppChange 的既有语义一致（应用一变就清掉不属于新应用集合的角色）。
 *   4. 本引擎的输出**不是**可直接提交的请求体。提交必须走 read-modify-write：
 *      先把目标用户全量详情拉回来，只替换 appIdList/roleIdList，其余字段原样回传。
 *      原因见 addOrEditModal.vue:533-573 —— editUser 是全量表单提交，不是增量 patch。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.AuthPermMap = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 角色展示名：优先 roleCode，缺失时退回名称/id。仅本模块内部用于生成 unresolved 说明 */
  function roleLabel(role) {
    if (!role) return '';
    return role.roleCode || role.roleName || role.appRoleName || String(role.id || '');
  }

  function toArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function indexById(list) {
    var m = {};
    toArray(list).forEach(function (x) {
      if (x && x.id !== undefined && x.id !== null) m[String(x.id)] = x;
    });
    return m;
  }

  /**
   * 建立 角色编码 -> 角色 的索引。
   * 键是 appId + '::' + roleCode（编码只在单个应用内唯一，跨应用会重复）。
   * 没有 roleCode 的角色不入索引 —— 这样它自然会落到 unresolved，而不是被按名称猜中。
   */
  function indexRolesByCode(roles) {
    var m = {};
    toArray(roles).forEach(function (r) {
      if (!r || !r.roleCode) return;
      var k = String(r.appId) + '::' + String(r.roleCode);
      if (!m[k]) m[k] = [];        // 同键多条是数据异常，收集起来供上层报警
      m[k].push(r);
    });
    return m;
  }

  /** 按 appCode 找目标环境应用 */
  function findTargetApp(targetApps, appCode) {
    var hit = toArray(targetApps).filter(function (a) {
      return a && String(a.appCode) === String(appCode);
    });
    return hit.length ? hit[0] : null;
  }

  /**
   * 跨环境映射。
   * @param {Object} src   源快照 { apps, roles, appIdList, roleIdList }
   * @param {Object} tgt   目标环境枚举 { apps, roles }
   * @returns {{appIdList:number[], roleIdList:number[], unresolved:Array, warnings:Array}}
   */
  function mapCrossEnv(src, tgt) {
    var srcApps = indexById(src.apps);
    var srcRoles = indexById(src.roles);
    var tgtApps = toArray(tgt.apps);
    var tgtRoleIndex = indexRolesByCode(tgt.roles);

    var unresolved = [];
    var warnings = [];

    // ① 应用：源 appId -> 源 appCode -> 目标 appId
    var appIdList = [];
    var seenApp = {};
    // 记录"被勾选过的源应用"及其映射结果。
    // 第 ② 步必须靠它判断角色的应用归属 —— 只判断"目标环境有没有这个应用"是不够的：
    // 源里没勾选的应用，其角色同样不能写进去（与页面 handleAppChange 的语义一致）。
    var selectedSrcApps = {};     // 源 appId -> { srcApp, targetApp|null }

    toArray(src.appIdList).forEach(function (sid) {
      var sa = srcApps[String(sid)];
      if (!sa) {
        unresolved.push({ kind: 'app', code: String(sid), reason: '源环境快照里找不到该应用，快照可能已过期' });
        return;
      }
      var hit = findTargetApp(tgtApps, sa.appCode);
      selectedSrcApps[String(sa.id)] = { srcApp: sa, targetApp: hit || null };
      if (!hit) {
        unresolved.push({ kind: 'app', appCode: sa.appCode, reason: '目标环境不存在该应用编码' });
        return;
      }
      if (!seenApp[String(hit.id)]) {
        seenApp[String(hit.id)] = true;
        appIdList.push(hit.id);
      }
    });

    // ② 角色：源 roleId -> (appCode, roleCode) -> 目标 roleId
    var roleIdList = [];
    var seenRole = {};

    toArray(src.roleIdList).forEach(function (rid) {
      var sr = srcRoles[String(rid)];
      if (!sr) {
        unresolved.push({ kind: 'role', code: String(rid), reason: '源环境快照里找不到该角色，快照可能已过期' });
        return;
      }
      var sa = srcApps[String(sr.appId)];
      if (!sa) {
        // 实测：selectAppRole 返回的角色远多于 selectApp 返回的应用
        // （mdmtest 实测 235 个角色里有 18 个 appId 不在应用列表内）。
        // 原因是 selectApp 只返回"当前登录人是应用管理员"的应用，
        // 所以这里多半不是数据脏，而是权限裁剪 —— 提示要能指导用户去要权限。
        unresolved.push({
          kind: 'role', appId: sr.appId, roleCode: sr.roleCode, roleName: roleLabel(sr),
          reason: '该角色所属应用不在当前账号可见的应用列表内（应用列表只含你有管理员权限的应用），无法定位其编码'
        });
        return;
      }
      // 边界 3：角色必须归属"已勾选且成功映射"的应用。两种情况分开报，便于定位。
      var sel = selectedSrcApps[String(sr.appId)];
      if (!sel) {
        unresolved.push({
          kind: 'role', appCode: sa.appCode, roleCode: sr.roleCode, roleName: roleLabel(sr),
          reason: '该角色所属应用未被勾选，按页面语义一并剔除'
        });
        return;
      }
      if (!sel.targetApp) {
        unresolved.push({
          kind: 'role', appCode: sa.appCode, roleCode: sr.roleCode, roleName: roleLabel(sr),
          reason: '角色所属应用未映射到目标环境，该角色一并跳过'
        });
        return;
      }
      var tgtApp = sel.targetApp;
      if (!sr.roleCode) {
        // 拿不到编码就不猜 —— 宁可让人工处理，也不要按名称写错权限
        unresolved.push({
          kind: 'role', appCode: sa.appCode, roleName: roleLabel(sr),
          reason: '该角色没有 roleCode（selectAppRole 未返回且 listByPage 补全失败），无法可靠匹配'
        });
        return;
      }
      var key = String(tgtApp.id) + '::' + String(sr.roleCode);
      var hits = tgtRoleIndex[key] || [];
      if (!hits.length) {
        unresolved.push({
          kind: 'role', appCode: sa.appCode, roleCode: sr.roleCode, roleName: roleLabel(sr),
          reason: '目标环境该应用下不存在此角色编码'
        });
        return;
      }
      if (hits.length > 1) {
        // 编码本应唯一，出现多条说明目标环境数据异常 -> 报出来，不擅自挑一条
        warnings.push({
          kind: 'role', appCode: sa.appCode, roleCode: sr.roleCode, count: hits.length,
          reason: '目标环境同一应用下该角色编码有多条，已取第一条，请人工确认数据'
        });
      }
      var tr = hits[0];
      if (!seenRole[String(tr.id)]) {
        seenRole[String(tr.id)] = true;
        roleIdList.push(tr.id);
      }
    });

    return { appIdList: appIdList, roleIdList: roleIdList, unresolved: unresolved, warnings: warnings };
  }

  /**
   * 同环境映射：id 直接可用，不需要编码翻译。
   * 仍要过滤两类脏数据：源里已不存在的 app/role、以及不属于已选应用的角色。
   * @param {Object} src 源（参照用户）快照
   * @param {Object} tgt 当前环境的枚举 { apps, roles }
   */
  function mapSameEnv(src, tgt) {
    var tgtApps = indexById(tgt.apps);
    var tgtRoles = indexById(tgt.roles);
    var unresolved = [];

    var appIdList = [];
    toArray(src.appIdList).forEach(function (aid) {
      if (tgtApps[String(aid)]) {
        if (appIdList.indexOf(aid) === -1) appIdList.push(aid);
      } else {
        unresolved.push({ kind: 'app', code: String(aid), reason: '当前环境已不存在该应用' });
      }
    });

    var roleIdList = [];
    toArray(src.roleIdList).forEach(function (rid) {
      var r = tgtRoles[String(rid)];
      if (!r) {
        unresolved.push({ kind: 'role', code: String(rid), reason: '当前环境已不存在该角色' });
        return;
      }
      // 与页面 handleAppChange 一致：角色必须归属已选应用
      if (appIdList.indexOf(r.appId) === -1) {
        unresolved.push({
          kind: 'role', roleCode: r.roleCode, roleName: r.roleName,
          reason: '该角色所属应用未被选中，按页面语义一并剔除'
        });
        return;
      }
      if (roleIdList.indexOf(rid) === -1) roleIdList.push(rid);
    });

    return { appIdList: appIdList, roleIdList: roleIdList, unresolved: unresolved, warnings: [] };
  }

  /** 集合差异：返回 added / removed / same，供执行前的二次确认展示（尤其是 removed） */
  function diffIds(currentIds, desiredIds) {
    var cur = toArray(currentIds).map(String);
    var des = toArray(desiredIds).map(String);
    return {
      added: des.filter(function (x) { return cur.indexOf(x) === -1; }),
      removed: cur.filter(function (x) { return des.indexOf(x) === -1; }),
      same: des.filter(function (x) { return cur.indexOf(x) !== -1; })
    };
  }

  /**
   * 生成完整执行计划。
   *
   * @param {Object} opts
   * @param {Object} opts.source        源快照 { env, apps, roles, appIdList, roleIdList, detail }
   * @param {Object} opts.target        目标环境枚举 { apps, roles }
   * @param {Object} opts.currentDetail 目标用户当前的 selectUserDetail 全量响应（read 阶段拿到的）
   * @param {'cross-env'|'same-env'} opts.mode
   * @returns {Object} 计划对象；若 plan.noop 为 true，则**不要发任何写请求**
   */
  function plan(opts) {
    var mode = opts.mode === 'same-env' ? 'same-env' : 'cross-env';
    var mapped = mode === 'same-env'
      ? mapSameEnv(opts.source, opts.target)
      : mapCrossEnv(opts.source, opts.target);

    var cur = opts.currentDetail || {};
    var appDiff = diffIds(cur.appIdList, mapped.appIdList);
    var roleDiff = diffIds(cur.roleIdList, mapped.roleIdList);

    // 幂等：两侧都没变化时明确标记 noop，执行阶段据此跳过写入（对应 AC3）
    var noop = appDiff.added.length === 0 && appDiff.removed.length === 0 &&
               roleDiff.added.length === 0 && roleDiff.removed.length === 0;

    return {
      mode: mode,
      appIdList: mapped.appIdList,
      roleIdList: mapped.roleIdList,
      appDiff: appDiff,
      roleDiff: roleDiff,
      unresolved: mapped.unresolved,
      warnings: mapped.warnings,
      noop: noop
    };
  }

  /**
   * 页面 editUser 会提交的字段白名单 —— 严格照抄 addOrEditModal.vue 的 formState + userId。
   *
   * 为什么用白名单而不是"展开 detail 再删两个"：
   *   selectUserDetail 返回的字段比页面 formState 多（实测多出 syncOutsideSystemVOList）。
   *   多提交一个字段就意味着让后端多处理一份数据，行为可能与页面不一致 ——
   *   而本插件的全部安全论据就是"严格镜像页面行为"。所以只允许页面会发的字段通过。
   */
  var PAGE_SUBMIT_FIELDS = [
    'userId', 'userName', 'nickName', 'password', 'userType',
    'partner', 'sex', 'phonenumber', 'email'
  ];

  /**
   * 构造 editUser 的提交载荷 —— read-modify-write，只换应用与角色。
   *
   * 为什么必须这么写（不要"优化"成只提交 userId+两个数组）：
   *   editUser 是全量表单提交（addOrEditModal.vue:533-573），只传两个数组会让
   *   后端把它们之外的字段当成空值处理，用户基础信息、同步外部系统等都可能被清掉。
   *
   * 三个刻意的取舍：
   *   1. 白名单取字段，不展开整个 detail（见 PAGE_SUBMIT_FIELDS 的说明）。
   *   2. 不提交 userDataList / userPublicFieldList —— 页面编辑态本就不提交
   *      （addOrEditModal.vue:538,542 被注释），照抄即可，避免把结构猜错。
   *   3. syncOutsideSystemList 只原样回传，绝不缩减：页面里已同步过的外部平台
   *      不允许移除（addOrEditModal.vue:750-751,770-771），插件不能比页面权限更大。
   */
  function buildEditPayload(currentDetail, desiredAppIds, desiredRoleIds) {
    var detail = currentDetail || {};
    var payload = {};

    PAGE_SUBMIT_FIELDS.forEach(function (k) {
      if (detail[k] !== undefined) payload[k] = detail[k];
    });

    payload.appIdList = toArray(desiredAppIds).slice();
    payload.roleIdList = toArray(desiredRoleIds).slice();

    // 后端对部门有默认值约定（addOrEditModal.vue:541）
    payload.deptId = (detail.deptId === null || detail.deptId === undefined) ? 0 : detail.deptId;

    payload.syncOutsideSystemList = toArray(detail.syncOutsideSystemList).slice();

    return payload;
  }

  /**
   * 疑似超级管理员的判定（启发式，宁可多提醒一次）。
   * 命中任一即返回原因字符串，否则返回空串。
   *
   * 为什么放在这个纯函数模块里：它是"执行前要不要多弹一次警告"的判据，
   * 属于安全相关的决策逻辑，必须能被单测覆盖，而不是埋在 DOM 代码里。
   */
  function superAdminReason(snap) {
    if (!snap) return '';
    if (String(snap.account || '').toLowerCase() === 'admin') return '账号名为 admin';
    var ids = toArray(snap.roleIdList);
    for (var i = 0; i < ids.length; i++) {
      var r = toArray(snap.roles).filter(function (x) { return String(x.id) === String(ids[i]); })[0];
      if (!r) continue;
      // 同时给出编码与名称：只回显其一都可能让人认不出是哪个角色
      var label = (r.roleCode || r.id) + (r.roleName ? '(' + r.roleName + ')' : '');
      // appId=0 的角色不属于任何应用（实测如 auth_manager），是全局/超管角色的特征
      if (r.appId === 0) return '持有不属于任何应用的全局角色 ' + label;
      if (/super_?manager|超级管理员/i.test(String(r.roleCode || '') + String(r.roleName || ''))) {
        return '持有角色 ' + label;
      }
    }
    return '';
  }

  /**
   * 从两个快照的宿主环境推导同步方式 —— 不再让用户手选。
   *
   * 为什么可以自动推导：同一环境下，跨环境分支做的其实是
   * appId → appCode → appId 的往返翻译，翻回原值。两条路径结果等价，
   * 让用户二选一只是多一个选错的机会。
   *
   * 但两者并非完全等价，同环境分支更稳，所以推导规则要偏向它：
   *   1. 同环境分支不要求角色有 roleCode（跨环境分支没有编码只能跳过）；
   *   2. 同环境分支只依赖目标环境的枚举，不依赖源环境枚举是否完整。
   * 规则：宿主字符串相同 → same-env；不同 → cross-env；任一缺失 → null（未采齐）。
   */
  function inferMode(srcSnapshot, tgtSnapshot) {
    if (!srcSnapshot || !tgtSnapshot) return null;
    var a = srcSnapshot.env && srcSnapshot.env.host;
    var b = tgtSnapshot.env && tgtSnapshot.env.host;
    if (!a || !b) return null;
    return String(a) === String(b) ? 'same-env' : 'cross-env';
  }

  // 环境配色：同一环境恒定同一颜色，用于在面板上一眼区分源/目标来自哪个环境。
  // 为什么先按命名约定匹配、而不是直接哈希：哈希只有很小的色板，dev 和 test
  // 一旦撞色就完全失去区分意义 —— 而这正是这个功能存在的理由。
  var ENV_FIXED_COLORS = [
    { re: /prod|prd/i, color: '#cf1322' },        // 生产：红
    { re: /uat|stg|staging/i, color: '#fa8c16' }, // 预发：橙
    { re: /test/i, color: '#389e0d' },            // 测试：绿
    { re: /dev/i, color: '#1890ff' }              // 开发：蓝
  ];
  // 未命中约定时按宿主哈希取色，保证同一宿主每次都得到同一个颜色
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

  /** 取宿主首段作为环境简称，如 mdmdev-auth.joyintoy.cn -> mdmdev-auth */
  function shortEnv(host) {
    var s = String(host || '');
    return s ? s.split('.')[0] : '';
  }

  // 允许「写入」的环境：只认开发/测试类宿主，其余一律只读。
  // 为什么是"白名单 + 默认拒绝"而不是"排除 prod"：
  //   漏判一个生产域名 = 可能真的改掉线上权限；误判一个测试域名 = 多点一次的事。
  //   两者代价完全不对等，所以默认取安全的那一侧。
  // 为什么 uat 不在白名单：公司口径是 dev/test/uat/prod 四套环境，uat 已是准生产
  //   （业务方在上面验收），按"生产"对待更符合直觉 —— 需要写时手动开豁免即可。
  // 只看宿主首段：避免把 ".com"、"--" 之类误当关键字命中。
  var WRITABLE_LABEL_RE = /(dev|test|sit)/i;

  function isWriteAllowed(host) {
    host = String(host || '').toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host.indexOf('localhost') === 0) return true;
    if (host === '127.0.0.1' || host.indexOf('127.0.0.1') === 0) return true;
    return WRITABLE_LABEL_RE.test(host.split('.')[0]);
  }

  /**
   * 环境的中文标签，用于提示文案。
   *
   * 为什么不能一律叫"生产"：只读白名单覆盖 uat / stg / prod 三类，
   * 把 uat 说成"生产"会让人以为插件认错了环境 —— 文案必须如实反映当前是哪类环境。
   * 生产宿主的判定：公司前端是 <env>[-auth].joyintoy.cn 的形态，
   * 不带环境前缀的 auth.joyintoy.cn 就是生产（用户确认）。
   */
  var PROD_HOST_RE = /^(auth|www)\.joyintoy\.cn$/i;
  var ENV_LABELS = [
    { re: /prod|prd/i, label: '生产' },
    { re: /stg|staging/i, label: '预发' },
    { re: /uat/i, label: '验收（准生产）' },
    { re: /sit/i, label: '集成测试' },
    { re: /test/i, label: '测试' },
    { re: /dev/i, label: '开发' }
  ];

  function envLabel(host) {
    host = String(host || '');
    if (!host) return '未知';
    if (PROD_HOST_RE.test(host)) return '生产';
    if (host === 'localhost' || host.indexOf('localhost') === 0) return '本地';
    if (host === '127.0.0.1' || host.indexOf('127.0.0.1') === 0) return '本地';
    var head = host.split('.')[0];
    for (var i = 0; i < ENV_LABELS.length; i++) {
      if (ENV_LABELS[i].re.test(head)) return ENV_LABELS[i].label;
    }
    return '未知';
  }

  /** 供界面展示：为什么这个环境不允许写 */
  function writeBlockReason(host) {
    if (isWriteAllowed(host)) return '';
    var h = String(host || '未知环境');
    return '「' + h + '」是' + envLabel(h) + '环境，默认只读、禁止写入。' +
           '可写环境只有开发 / 测试 / 集成测试（另放行 localhost）；' +
           '确有需要可在面板头部点「开启写入」临时豁免。';
  }

  return {
    mapCrossEnv: mapCrossEnv,
    mapSameEnv: mapSameEnv,
    diffIds: diffIds,
    plan: plan,
    buildEditPayload: buildEditPayload,
    indexRolesByCode: indexRolesByCode,
    superAdminReason: superAdminReason,
    inferMode: inferMode,
    envColor: envColor,
    shortEnv: shortEnv,
    isWriteAllowed: isWriteAllowed,
    writeBlockReason: writeBlockReason,
    envLabel: envLabel
  };
});
