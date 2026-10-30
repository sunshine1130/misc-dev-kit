'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const G = require(path.join(__dirname, '..', 'env-guard.js'));

test('可写环境：首段含 dev/test/sit/uat', () => {
  ['mdmdev.joyintoy.cn', 'mdmdev-auth.joyintoy.cn',
   'mdmtest.joyintoy.cn', 'mdmtest-auth.joyintoy.cn',
   'sit-auth.joyintoy.cn', 'uat-auth.joyintoy.cn',
   'localhost', '127.0.0.1', 'localhost:8080'].forEach(h => {
    assert.equal(G.isWriteAllowed(h), true, h + ' 应可写');
    assert.equal(G.writeBlockReason(h), '', h + ' 不应有拦截原因');
  });
});

test('只读环境：生产 / 预发 / 未知域名', () => {
  ['auth.joyintoy.cn', 'www.joyintoy.cn', 'stg-auth.joyintoy.cn',
   'mdm.joyintoy.cn', 'example.com', '', 'a.b.c'].forEach(h => {
    assert.equal(G.isWriteAllowed(h), false, h + ' 应只读');
    assert.ok(G.writeBlockReason(h).length > 0, h + ' 应给出拦截原因');
  });
});

test('大小写与空白不影响判定', () => {
  assert.equal(G.isWriteAllowed('MDMDEV.joyintoy.cn'), true);
  assert.equal(G.isWriteAllowed('AUTH.JOYINTOY.CN'), false);
});

test('环境标签如实反映类型，不把非生产说成生产', () => {
  assert.equal(G.envLabel('auth.joyintoy.cn'), '生产');
  assert.equal(G.envLabel('www.joyintoy.cn'), '生产');
  assert.equal(G.envLabel('uat-auth.joyintoy.cn'), '验收测试');
  assert.equal(G.envLabel('stg-auth.joyintoy.cn'), '预发');
  assert.equal(G.envLabel('mdmtest-auth.joyintoy.cn'), '测试');
  assert.equal(G.envLabel('mdmdev-auth.joyintoy.cn'), '开发');
  assert.equal(G.envLabel('localhost'), '本地');
  assert.equal(G.envLabel('example.com'), '未知');

  // 只读提示里必须出现真实的环境类型，uat 不能被叫成"生产"
  assert.ok(G.writeBlockReason('uat-auth.joyintoy.cn') === '', 'uat 可写，不该有拦截原因');
  assert.ok(G.writeBlockReason('stg-auth.joyintoy.cn').includes('预发'));
  assert.ok(G.writeBlockReason('auth.joyintoy.cn').includes('生产'));
  assert.ok(!G.writeBlockReason('example.com').includes('生产'), '未知域名不能说成生产');
});

test('写接口识别：已知的 4 个写接口都要被认出来', () => {
  ['/base/dictType/add', '/base/dictType/edit',
   '/base/dictData/add', '/base/dictData/edit'].forEach(p => {
    assert.equal(G.isWritePath(p), true, p + ' 应被判为写接口');
  });
});

test('写接口识别：只读接口不能误判为写', () => {
  // 误判的代价是"生产上连数据都看不了"，所以这两条必须钉住
  ['/base/dictType/listPage', '/base/dictData/listPage'].forEach(p => {
    assert.equal(G.isWritePath(p), false, p + ' 不应被判为写接口');
  });
  // 带 host 前缀、带 query 的完整形态也要正确
  assert.equal(G.isWritePath('https://mdmdev.joyintoy.cn/base/dictData/listPage'), false);
  assert.equal(G.isWritePath('/base/dictData/listPage?pageNum=1'), false);
  assert.equal(G.isWritePath('/base/dictData/add?x=1'), true);
});

test('写接口识别：兜底动词（以后新增的接口默认受保护）', () => {
  ['/base/dictType/remove', '/base/dictType/batchDelete',
   '/base/dictData/update', '/base/dictType/save', '/base/dictType/import'].forEach(p => {
    assert.equal(G.isWritePath(p), true, p + ' 应被判为写接口');
  });
});

test('空路径不当作写接口（避免误拦）', () => {
  assert.equal(G.isWritePath(''), false);
  assert.equal(G.isWritePath(null), false);
  assert.equal(G.isWritePath(undefined), false);
});
