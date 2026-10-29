/**
 * perm-map.js 单元测试
 *
 * 跑法：node tests/perm-map.test.cjs
 * 为什么不用测试框架：这个扩展目录没有 package.json / 构建步骤（就是"加载已解压"的裸文件），
 * 引入 jest 之类会平白多出一套依赖。node 自带的 assert 足够覆盖这里的纯函数逻辑。
 *
 * 重点覆盖"算错会写坏线上权限"的分支：映射不到时的处理、角色的应用归属、幂等、提交载荷不被裁剪。
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const M = require(path.join(__dirname, '..', 'perm-map.js'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('      ' + e.message.split('\n').join('\n      '));
  }
}

// ── 测试夹具：模拟 dev(源) 与 test(目标) 两个环境的枚举，id 故意完全不同 ──
const DEV = {
  env: { host: 'dev.joyintoy.cn' },
  apps: [
    { id: 11, appCode: 'aps', appName: 'APS' },
    { id: 12, appCode: 'tms', appName: 'TMS' },
    { id: 13, appCode: 'wms', appName: 'WMS' }   // 目标环境没有这个应用
  ],
  roles: [
    { id: 101, appId: 11, roleCode: 'aps-admin', roleName: 'APS管理员' },
    { id: 102, appId: 12, roleCode: 'tms-viewer', roleName: 'TMS只读' },
    { id: 103, appId: 13, roleCode: 'wms-op', roleName: 'WMS操作' },
    { id: 104, appId: 11, roleName: '无编码角色' }   // 故意没有 roleCode
  ],
  appIdList: [11, 12],
  roleIdList: [101, 102]
};

const TESTENV = {
  apps: [
    { id: 201, appCode: 'aps', appName: 'APS' },
    { id: 202, appCode: 'tms', appName: 'TMS' }
    // 没有 wms
  ],
  roles: [
    { id: 501, appId: 201, roleCode: 'aps-admin', roleName: 'APS管理员' },
    { id: 502, appId: 202, roleCode: 'tms-viewer', roleName: 'TMS只读' },
    { id: 503, appId: 201, roleCode: 'aps-auditor', roleName: 'APS审计' }  // 源没有
  ]
};

console.log('perm-map.js');
console.log('\n[cross-env] 跨环境映射');

test('按 appCode / appCode+roleCode 映射，ID 全部换成目标环境的', () => {
  const r = M.mapCrossEnv(DEV, TESTENV);
  assert.deepStrictEqual(r.appIdList, [201, 202], '应用应映射为 test 的 id');
  assert.deepStrictEqual(r.roleIdList, [501, 502], '角色应映射为 test 的 id');
  assert.strictEqual(r.unresolved.length, 0, '不应有无法映射项');
});

test('绝不把源环境的 id 原样带过去（AC5）', () => {
  const r = M.mapCrossEnv(DEV, TESTENV);
  [11, 12, 13].forEach(id => assert.ok(!r.appIdList.includes(id), `appId ${id} 不该出现在结果里`));
  [101, 102, 103, 104].forEach(id => assert.ok(!r.roleIdList.includes(id), `roleId ${id} 不该出现在结果里`));
});

test('目标环境缺 appCode：该应用与其下角色都进 unresolved，且不写入', () => {
  const src = { ...DEV, appIdList: [11, 13], roleIdList: [101, 103] };
  const r = M.mapCrossEnv(src, TESTENV);
  assert.deepStrictEqual(r.appIdList, [201], '只应映射上 aps');
  assert.deepStrictEqual(r.roleIdList, [501], 'wms-op 不该被写入');
  const appMiss = r.unresolved.filter(u => u.kind === 'app');
  const roleMiss = r.unresolved.filter(u => u.kind === 'role');
  assert.strictEqual(appMiss.length, 1);
  assert.strictEqual(appMiss[0].appCode, 'wms');
  assert.strictEqual(roleMiss.length, 1);
  assert.strictEqual(roleMiss[0].roleCode, 'wms-op');
});

test('角色没有 roleCode 时进 unresolved —— 不按名称猜（核心安全边界）', () => {
  const src = { ...DEV, appIdList: [11], roleIdList: [104] };
  const r = M.mapCrossEnv(src, TESTENV);
  assert.deepStrictEqual(r.roleIdList, [], '没有编码就不能写任何角色');
  assert.strictEqual(r.unresolved.length, 1);
  assert.match(r.unresolved[0].reason, /roleCode/);
});

test('角色所属应用不在应用列表内 → 提示要指向"管理员权限"，而不是含糊的"不在快照中"', () => {
  // 实测背景：selectApp 只返回"当前登录人是应用管理员"的应用，
  // 而 selectAppRole 返回全部角色（mdmtest 实测 235 角色里有 18 个 appId 不在应用列表内）。
  const src = {
    apps: [{ id: 11, appCode: 'aps', appName: 'APS' }],
    roles: [{ id: 201, appId: 99, roleCode: 'orphan-role', roleName: '孤儿角色' }],
    appIdList: [11],
    roleIdList: [201]
  };
  const r = M.mapCrossEnv(src, TESTENV);
  assert.strictEqual(r.roleIdList.length, 0);
  assert.strictEqual(r.unresolved.length, 1);
  assert.match(r.unresolved[0].reason, /管理员权限/);
  assert.strictEqual(r.unresolved[0].roleCode, 'orphan-role', '要带上 roleCode 才好定位');
});

test('目标环境有该应用但没有该角色编码 -> unresolved，不误配同名角色', () => {
  const src = {
    ...DEV,
    apps: [...DEV.apps, { id: 14, appCode: 'aps', appName: 'APS' }],
    roles: [{ id: 105, appId: 11, roleCode: 'aps-ghost', roleName: 'APS管理员' }], // 名字与 501 相同
    appIdList: [11],
    roleIdList: [105]
  };
  const r = M.mapCrossEnv(src, TESTENV);
  assert.deepStrictEqual(r.roleIdList, [], '同名不同编码不得匹配');
  assert.match(r.unresolved[0].reason, /不存在此角色编码/);
});

test('角色所属应用未被勾选 -> 该角色跳过并说明', () => {
  const src = { ...DEV, appIdList: [11], roleIdList: [102] };  // 102 属于 tms(12)，但只勾了 aps
  const r = M.mapCrossEnv(src, TESTENV);
  assert.deepStrictEqual(r.appIdList, [201]);
  assert.deepStrictEqual(r.roleIdList, [], 'tms 角色不该落地');
  assert.match(r.unresolved[0].reason, /未被勾选/);
});

test('快照过期（源里找不到 id）会明确报出来而不是静默丢弃', () => {
  const r = M.mapCrossEnv(DEV, TESTENV);
  const stale = M.mapCrossEnv({ ...DEV, appIdList: [999], roleIdList: [888] }, TESTENV);
  assert.strictEqual(r.unresolved.length, 0);
  assert.strictEqual(stale.unresolved.length, 2);
  assert.ok(stale.unresolved.every(u => /快照/.test(u.reason)));
});

test('同一应用编码在目标环境重复时给 warning，不静默取第一条', () => {
  const dup = { apps: TESTENV.apps, roles: [...TESTENV.roles, { id: 599, appId: 201, roleCode: 'aps-admin', roleName: 'APS管理员副本' }] };
  const r = M.mapCrossEnv({ ...DEV, appIdList: [11], roleIdList: [101] }, dup);
  assert.strictEqual(r.warnings.length, 1, '应报一条数据异常警告');
  assert.strictEqual(r.roleIdList.length, 1, '仍只写入一条');
});

console.log('\n[same-env] 同环境模板复制');

const SAME = {
  apps: [{ id: 11, appCode: 'aps', appName: 'APS' }, { id: 12, appCode: 'tms', appName: 'TMS' }],
  roles: [
    { id: 101, appId: 11, roleCode: 'aps-admin', roleName: 'APS管理员' },
    { id: 102, appId: 12, roleCode: 'tms-viewer', roleName: 'TMS只读' }
  ]
};

test('同环境直接用 id，且剔除不属于已选应用的角色', () => {
  const r = M.mapSameEnv({ appIdList: [11], roleIdList: [101, 102] }, SAME);
  assert.deepStrictEqual(r.appIdList, [11]);
  assert.deepStrictEqual(r.roleIdList, [101], '102 属于 tms，应用未选中应剔除');
  assert.match(r.unresolved[0].reason, /所属应用未被选中/);
});

test('同环境遇到已删除的应用/角色会报出来', () => {
  const r = M.mapSameEnv({ appIdList: [11, 77], roleIdList: [101, 88] }, SAME);
  assert.deepStrictEqual(r.appIdList, [11]);
  assert.deepStrictEqual(r.roleIdList, [101]);
  assert.strictEqual(r.unresolved.length, 2);
});

console.log('\n[diff / plan] 差异与幂等');

test('diff 正确分出 added / removed / same（removed 是要二次确认的重点）', () => {
  const d = M.diffIds([11, 12, 13], [12, 13, 14]);
  assert.deepStrictEqual(d.added, ['14']);
  assert.deepStrictEqual(d.removed, ['11']);
  assert.deepStrictEqual(d.same, ['12', '13']);
});

test('权限已完全一致时 plan.noop 为 true（AC3：不发任何写请求）', () => {
  const currentDetail = { userId: 7, appIdList: [201, 202], roleIdList: [501, 502] };
  const p = M.plan({ source: DEV, target: TESTENV, currentDetail, mode: 'cross-env' });
  assert.strictEqual(p.noop, true, '不应重复写入');
  assert.deepStrictEqual(p.appDiff.removed, []);
  assert.deepStrictEqual(p.roleDiff.removed, []);
});

test('需要移除权限时 noop 为 false，且 removed 可被展示', () => {
  const currentDetail = { userId: 7, appIdList: [201, 202, 999], roleIdList: [501, 502, 888] };
  const p = M.plan({ source: DEV, target: TESTENV, currentDetail, mode: 'cross-env' });
  assert.strictEqual(p.noop, false);
  assert.deepStrictEqual(p.appDiff.removed, ['999']);
  assert.deepStrictEqual(p.roleDiff.removed, ['888']);
});

test('同环境模式走 id 直连，不做编码翻译', () => {
  const p = M.plan({
    source: { appIdList: [11], roleIdList: [101] },
    target: SAME,
    currentDetail: { userId: 7, appIdList: [], roleIdList: [] },
    mode: 'same-env'
  });
  assert.strictEqual(p.mode, 'same-env');
  assert.deepStrictEqual(p.appIdList, [11]);
  assert.deepStrictEqual(p.roleIdList, [101]);
  assert.strictEqual(p.noop, false);
});

console.log('\n[payload] editUser 提交载荷');

test('read-modify-write：基础字段原样保留，只替换两个数组', () => {
  const detail = {
    userId: 7, userName: 'apsTest', nickName: '王麒麟', sex: '1', userType: '00',
    deptId: 33, partner: '', phonenumber: '13800000000', email: 'a@b.com',
    appIdList: [201], roleIdList: [501], syncOutsideSystemList: ['weaver'],
    userDataList: [{ appId: 201, resourceId: 1, userDataDetailList: [{ resourceDetailId: 9 }] }],
    userPublicFieldList: [{ appId: 201, code: 'f1', visible: 0 }]
  };
  const p = M.buildEditPayload(detail, [201, 202], [501, 502]);

  assert.strictEqual(p.userId, 7);
  assert.strictEqual(p.userName, 'apsTest');
  assert.strictEqual(p.nickName, '王麒麟');
  assert.strictEqual(p.deptId, 33);
  assert.strictEqual(p.email, 'a@b.com');
  assert.deepStrictEqual(p.appIdList, [201, 202]);
  assert.deepStrictEqual(p.roleIdList, [501, 502]);
  assert.deepStrictEqual(p.syncOutsideSystemList, ['weaver'], '外部系统列表不得缩减');
  assert.ok(!('userDataList' in p), 'userDataList 不提交，照抄页面编辑态行为');
  assert.ok(!('userPublicFieldList' in p), 'userPublicFieldList 不提交');
});

test('白名单：接口多返回的字段不得被带进载荷（实测返回 syncOutsideSystemVOList）', () => {
  // 实环境 selectUserDetail 返回的字段比页面 formState 多，多传就是偏离"镜像页面"
  const detail = {
    userId: 358, userName: 'testAPSAuth', nickName: 'sh测试权限账号',
    userType: '01', partner: '1', sex: '0', deptId: 61,
    phonenumber: '13733333333', email: 'sdfsdf@joyin.com',
    appIdList: [39, 44], roleIdList: [108, 117],
    userDataList: [], userPublicFieldList: [],
    syncOutsideSystemList: [], syncOutsideSystemVOList: [],
    createBy: 'x', createTime: '2026-01-01', updateBy: 'y', updateTime: '2026-01-02'
  };
  const p = M.buildEditPayload(detail, detail.appIdList, detail.roleIdList);
  assert.ok(!('syncOutsideSystemVOList' in p), 'VO 列表不该提交');
  assert.ok(!('createBy' in p) && !('updateTime' in p), '审计字段不该提交');
  assert.deepStrictEqual(
    Object.keys(p).sort(),
    ['appIdList', 'deptId', 'email', 'nickName', 'partner', 'phonenumber',
     'roleIdList', 'sex', 'syncOutsideSystemList', 'userId', 'userName', 'userType'].sort(),
    '载荷字段集必须与页面 formState 完全一致'
  );
});

test('deptId 为 null 时补 0（后端默认值约定）', () => {
  assert.strictEqual(M.buildEditPayload({ deptId: null }, [], []).deptId, 0);
  assert.strictEqual(M.buildEditPayload({}, [], []).deptId, 0);
  assert.strictEqual(M.buildEditPayload({ deptId: 0 }, [], []).deptId, 0);
});

test('不修改传入的原对象（纯函数）', () => {
  const detail = { userId: 1, appIdList: [1], roleIdList: [2], userDataList: [] };
  const snapshot = JSON.stringify(detail);
  M.buildEditPayload(detail, [9], [9]);
  assert.strictEqual(JSON.stringify(detail), snapshot, '入参不该被改动');
});

console.log('\n[superAdminReason] 疑似超管判定（执行前额外告警的判据）');

const ROLES = [
  { id: 1, appId: 11, roleCode: 'aps-admin', roleName: 'APS管理员' },
  { id: 2, appId: 0, roleCode: 'auth_manager', roleName: '权限系统管理员' },
  { id: 3, appId: 11, roleCode: 'auth_super_manager', roleName: '权限超级管理员' }
];

test('账号名为 admin 直接判定', () => {
  assert.match(M.superAdminReason({ account: 'admin', roles: ROLES, roleIdList: [] }), /admin/);
  assert.match(M.superAdminReason({ account: 'ADMIN', roles: ROLES, roleIdList: [] }), /admin/);
});

test('持有 appId=0 的全局角色 → 判定命中并说明原因', () => {
  const r = M.superAdminReason({ account: 'zhangsan', roles: ROLES, roleIdList: [2] });
  assert.match(r, /全局角色/);
  assert.match(r, /auth_manager/);
});

test('角色名含 super_manager / 超级管理员 → 命中', () => {
  assert.match(M.superAdminReason({ account: 'zhangsan', roles: ROLES, roleIdList: [3] }), /auth_super_manager/);
  const cn = [{ id: 9, appId: 11, roleCode: 'x', roleName: '权限超级管理员' }];
  assert.match(M.superAdminReason({ account: 'zhangsan', roles: cn, roleIdList: [9] }), /超级管理员/);
});

test('普通账号返回空串（不要误报，否则告警会变噪音）', () => {
  assert.strictEqual(M.superAdminReason({ account: 'zhangsan', roles: ROLES, roleIdList: [1] }), '');
  assert.strictEqual(M.superAdminReason({ account: 'zhangsan', roles: ROLES, roleIdList: [] }), '');
  assert.strictEqual(M.superAdminReason(null), '');
});

test('角色 id 在枚举里找不到时不崩、也不误判', () => {
  assert.strictEqual(M.superAdminReason({ account: 'zhangsan', roles: ROLES, roleIdList: [999] }), '');
});

console.log('\n[inferMode] 同步方式自动推导（替代手选模式）');

test('同一宿主 → same-env', () => {
  assert.strictEqual(M.inferMode({ env: { host: 'mdmtest-auth.joyintoy.cn' } },
                                 { env: { host: 'mdmtest-auth.joyintoy.cn' } }), 'same-env');
});

test('不同宿主 → cross-env', () => {
  assert.strictEqual(M.inferMode({ env: { host: 'mdmdev-auth.joyintoy.cn' } },
                                 { env: { host: 'mdmtest-auth.joyintoy.cn' } }), 'cross-env');
});

test('任一快照缺失或取不到宿主 → null（未采齐，不猜）', () => {
  assert.strictEqual(M.inferMode(null, { env: { host: 'a' } }), null);
  assert.strictEqual(M.inferMode({ env: { host: 'a' } }, null), null);
  assert.strictEqual(M.inferMode({}, { env: { host: 'a' } }), null);
  assert.strictEqual(M.inferMode({ env: { host: 'a' } }, {}), null);
});

console.log('\n[envColor] 环境配色（同名账号来自哪个环境，一眼可辨）');

test('dev / test / uat / prod 各自稳定且互不相同', () => {
  const dev = M.envColor('mdmdev-auth.joyintoy.cn');
  const tst = M.envColor('mdmtest-auth.joyintoy.cn');
  const uat = M.envColor('uat.joyintoy.cn');
  const prd = M.envColor('prod-auth.joyintoy.cn');
  const all = [dev, tst, uat, prd];
  assert.strictEqual(new Set(all).size, 4, '四个环境的颜色必须互不相同：' + all.join(', '));
  assert.strictEqual(dev, M.envColor('dev.joyintoy.cn'), '同为 dev 的环境应同色');
  assert.strictEqual(tst, M.envColor('test.joyintoy.cn'), '同为 test 的环境应同色');
});

test('同一宿主每次取色一致（不能一次蓝一次绿）', () => {
  for (const h of ['mdmdev-auth.joyintoy.cn', 'mdmtest-auth.joyintoy.cn', 'weird-host.internal']) {
    assert.strictEqual(M.envColor(h), M.envColor(h));
  }
});

test('未命中命名约定时回退哈希取色，且仍是合法色值', () => {
  const c = M.envColor('something-unusual.example.com');
  assert.match(c, /^#[0-9a-f]{6}$/i);
  assert.strictEqual(c, M.envColor('something-unusual.example.com'));
});

test('空宿主不炸', () => {
  assert.match(M.envColor(''), /^#[0-9a-f]{6}$/i);
  assert.match(M.envColor(null), /^#[0-9a-f]{6}$/i);
});

test('环境简称取宿主首段', () => {
  assert.strictEqual(M.shortEnv('mdmdev-auth.joyintoy.cn'), 'mdmdev-auth');
  assert.strictEqual(M.shortEnv('mdmtest-auth.joyintoy.cn'), 'mdmtest-auth');
  assert.strictEqual(M.shortEnv(''), '');
});

console.log('\n[isWriteAllowed] 环境只读白名单（生产默认只读）');

test('开发/测试类环境允许写入（含 uat —— 用户确认 uat 本质仍是测试环境）', () => {
  for (const h of ['mdmdev-auth.joyintoy.cn', 'mdmtest-auth.joyintoy.cn', 'dev.joyintoy.cn',
                   'test.joyintoy.cn', 'sit.joyintoy.cn', 'uat.joyintoy.cn', 'uat-auth.joyintoy.cn',
                   'localhost', 'localhost:8080', '127.0.0.1']) {
    assert.strictEqual(M.isWriteAllowed(h), true, h + ' 应允许写入');
  }
});

test('生产 / 预发 / 未知宿主一律只读（默认拒绝）', () => {
  for (const h of ['auth.joyintoy.cn', 'www.joyintoy.cn', 'api.joyintoy.cn', 'joyintoy.cn',
                   'stg.joyintoy.cn', 'staging.joyintoy.cn',
                   'prod-auth.joyintoy.cn', 'mdmprod-auth.joyintoy.cn', 'prd.joyintoy.cn',
                   'something.example.com', '']) {
    assert.strictEqual(M.isWriteAllowed(h), false, h + ' 应被判定为只读');
  }
});

test('关键词按首段做子串匹配（为了兼容 mdmdev/mdmtest 这类命名）', () => {
  // 公司的前端宿主形如 mdm<env>-auth.joyintoy.cn —— 环境关键词嵌在首段内部、没有分隔符，
  // 所以不能用词边界，只能子串匹配。代价见下条断言，方向是"误放行"而非"误拦截"。
  assert.strictEqual(M.isWriteAllowed('mdmdev-auth.joyintoy.cn'), true);
  assert.strictEqual(M.isWriteAllowed('mdmtest-auth.joyintoy.cn'), true);
  assert.strictEqual(M.isWriteAllowed('dev.example.com'), true);
  // 已知取舍：首段里只要出现关键词就放行（如 contest）
  assert.strictEqual(M.isWriteAllowed('contest.example.com'), true);
  // 但关键词出现在非首段则完全不影响判断
  assert.strictEqual(M.isWriteAllowed('shop.contest.com'), false);
  assert.strictEqual(M.isWriteAllowed('auth.dev-cdn.com'), false, '只看首段');
});

test('writeBlockReason：允许时为空串，禁止时给出可操作的原因', () => {
  assert.strictEqual(M.writeBlockReason('mdmtest-auth.joyintoy.cn'), '');
  const r = M.writeBlockReason('auth.joyintoy.cn');
  assert.ok(r.length > 0);
  assert.match(r, /只读/);
  assert.match(r, /auth\.joyintoy\.cn/);
});

console.log('\n[envLabel] 环境中文标签（提示文案不能把 uat 说成生产）');

test('各环境标签如实反映是哪一类环境', () => {
  assert.strictEqual(M.envLabel('mdmdev-auth.joyintoy.cn'), '开发');
  assert.strictEqual(M.envLabel('mdmtest-auth.joyintoy.cn'), '测试');
  assert.strictEqual(M.envLabel('sit-auth.joyintoy.cn'), '集成测试');
  assert.strictEqual(M.envLabel('uat-auth.joyintoy.cn'), '验收测试');
  assert.strictEqual(M.envLabel('stg-auth.joyintoy.cn'), '预发');
});

test('不带环境前缀的 auth.joyintoy.cn 判定为生产（用户确认的宿主形态）', () => {
  assert.strictEqual(M.envLabel('auth.joyintoy.cn'), '生产');
  assert.strictEqual(M.envLabel('www.joyintoy.cn'), '生产');
  assert.strictEqual(M.envLabel('mdmprod-auth.joyintoy.cn'), '生产');
});

test('本地与未知环境', () => {
  assert.strictEqual(M.envLabel('localhost'), '本地');
  assert.strictEqual(M.envLabel('localhost:8080'), '本地');
  assert.strictEqual(M.envLabel('127.0.0.1'), '本地');
  assert.strictEqual(M.envLabel('weird.example.com'), '未知');
  assert.strictEqual(M.envLabel(''), '未知');
});

test('拒绝写入的文案带上真实环境类型，且不把非生产环境说成生产', () => {
  assert.strictEqual(M.writeBlockReason('uat-auth.joyintoy.cn'), '', 'uat 可写，不该有拒绝文案');
  const stg = M.writeBlockReason('stg-auth.joyintoy.cn');
  assert.match(stg, /预发/);
  assert.ok(stg.indexOf('是生产环境') === -1, 'stg 的文案不该说自己是生产');
  const prd = M.writeBlockReason('auth.joyintoy.cn');
  assert.match(prd, /是生产环境/);
});

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed === 0 ? 0 : 1);
