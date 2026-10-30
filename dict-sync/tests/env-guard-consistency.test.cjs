'use strict';

/**
 * 跨扩展一致性测试：dict-sync/env-guard.js 与 auth-resource-sync/perm-map.js
 * 里的环境规则必须是同一套行为。
 *
 * 为什么需要它：两个扩展各自独立加载（unpacked、无构建步骤），没法 require
 * 同一个文件，所以规则是两份实现。没有这道测试，两份会在某次"顺手改一下"之后
 * 悄悄分叉 —— 表现就是同一个域名在一个扩展里可写、在另一个里只读，同事会以为
 * 插件坏了。这里是**行为一致性**比对，不比对源码文本（文本可以不同，结论不能）。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const DictEnv = require(path.join(__dirname, '..', 'env-guard.js'));
const AuthPermMap = require(path.join(__dirname, '..', '..', 'auth-resource-sync', 'perm-map.js'));

// 覆盖面要够：四类环境、生产两种写法、本地两种写法、未知域名、边界形态
const HOSTS = [
  'mdmdev.joyintoy.cn', 'mdmdev-auth.joyintoy.cn', 'dev.joyintoy.cn',
  'mdmtest.joyintoy.cn', 'mdmtest-auth.joyintoy.cn', 'test.joyintoy.cn',
  'sit-auth.joyintoy.cn', 'uat-auth.joyintoy.cn', 'stg-auth.joyintoy.cn',
  'auth.joyintoy.cn', 'www.joyintoy.cn', 'joyintoy.cn',
  // 用户 2026-10-30 实测确认的 zt 系列（dict-sync 就跑在这套域名上）
  'zt.joyintoy.cn', 'test-zt.joyintoy.cn', 'uat-zt.joyintoy.cn',
  // 无环境标记的其他公司主域：新规则下都算生产
  'some-other-app.joyintoy.cn',
  'localhost', 'localhost:8080', '127.0.0.1',
  'example.com', 'zt.example.com', 'a.b.c.d', '', 'prodx.joyintoy.cn', 'MDMDEV.joyintoy.cn'
];

test('可写判定完全一致', () => {
  HOSTS.forEach(h => {
    assert.equal(
      DictEnv.isWriteAllowed(h), AuthPermMap.isWriteAllowed(h),
      `isWriteAllowed("${h}") 两个扩展不一致：dict=${DictEnv.isWriteAllowed(h)} auth=${AuthPermMap.isWriteAllowed(h)}`);
  });
});

test('环境标签完全一致', () => {
  HOSTS.forEach(h => {
    assert.equal(
      DictEnv.envLabel(h), AuthPermMap.envLabel(h),
      `envLabel("${h}") 两个扩展不一致：dict=${DictEnv.envLabel(h)} auth=${AuthPermMap.envLabel(h)}`);
  });
});

test('环境颜色完全一致（同一环境两个扩展必须是同一色）', () => {
  HOSTS.forEach(h => {
    assert.equal(
      DictEnv.envColor(h), AuthPermMap.envColor(h),
      `envColor("${h}") 两个扩展不一致：dict=${DictEnv.envColor(h)} auth=${AuthPermMap.envColor(h)}`);
  });
});

test('环境简称完全一致', () => {
  HOSTS.forEach(h => {
    assert.equal(DictEnv.shortEnv(h), AuthPermMap.shortEnv(h), `shortEnv("${h}") 不一致`);
  });
});

test('拦截原因的"可写/不可写"结论一致（措辞可以不同）', () => {
  HOSTS.forEach(h => {
    const d = DictEnv.writeBlockReason(h);
    const a = AuthPermMap.writeBlockReason(h);
    assert.equal(d === '', a === '', `writeBlockReason("${h}") 一个说可写一个说只读`);
    if (d !== '') {
      // 不可写时，两边都必须点出真实的环境类型
      assert.ok(d.includes(DictEnv.envLabel(h)), `dict 的拦截原因未点明环境类型：${d}`);
      assert.ok(a.includes(AuthPermMap.envLabel(h)), `auth 的拦截原因未点明环境类型：${a}`);
    }
  });
});
