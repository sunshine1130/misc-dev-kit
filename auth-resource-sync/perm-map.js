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

  /** 取名字用于展示：应用优先 appCode，角色优先 roleCode，缺失时退回名称 */
  function appLabel(app) {
    return (app && (app.appCode || app.appName)) || String((app && app.id) || '');
  }
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
    var appCodeByTargetId = {};   // 目标 appId -> appCode，供第 ② 步反查
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
      appCodeByTargetId[String(hit.id)] = sa.appCode;
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
        unresolved.push({ kind: 'role', appId: sr.appId, roleName: sr.roleName, reason: '角色所属应用不在源快照中' });
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
   * 构造 editUser 的提交载荷 —— read-modify-write，只换应用与角色。
   *
   * 为什么必须这么写（不要"优化"成只提交 userId+两个数组）：
   *   editUser 是全量表单提交（addOrEditModal.vue:533-573），只传两个数组会让
   *   后端把它们之外的字段当成空值处理，用户基础信息、同步外部系统等都可能被清掉。
   *   本函数刻意把 currentDetail 原样展开，只覆盖 appIdList / roleIdList。
   *
   * syncOutsideSystemList 只增不减：页面里已同步过的外部平台不允许移除
   *   （addOrEditModal.vue:750-751,770-771），插件不能比页面权限更大。
   */
  function buildEditPayload(currentDetail, desiredAppIds, desiredRoleIds) {
    var detail = currentDetail || {};
    var payload = {};
    Object.keys(detail).forEach(function (k) {
      // userDataList / userPublicFieldList 是只读回显数据，页面编辑态本就不提交
      // （addOrEditModal.vue:538,542 被注释）；照抄页面行为，避免把数据结构猜错。
      if (k === 'userDataList' || k === 'userPublicFieldList') return;
      payload[k] = detail[k];
    });

    payload.appIdList = toArray(desiredAppIds).slice();
    payload.roleIdList = toArray(desiredRoleIds).slice();

    // 后端对部门有默认值约定（addOrEditModal.vue:541）
    payload.deptId = (detail.deptId === null || detail.deptId === undefined) ? 0 : detail.deptId;

    // 外部系统同步列表：取原值，不缩减（边界 7）
    payload.syncOutsideSystemList = toArray(detail.syncOutsideSystemList).slice();

    return payload;
  }

  return {
    mapCrossEnv: mapCrossEnv,
    mapSameEnv: mapSameEnv,
    diffIds: diffIds,
    plan: plan,
    buildEditPayload: buildEditPayload,
    indexRolesByCode: indexRolesByCode,
    appLabel: appLabel,
    roleLabel: roleLabel
  };
});
