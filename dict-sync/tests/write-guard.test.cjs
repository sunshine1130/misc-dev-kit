'use strict';

/**
 * guardWrite 的组合逻辑单测。
 *
 * 为什么值得单独测这三行：它是"按钮置灰"之外**真正的安全边界**（按钮置灰只是
 * 让人看得见）。而它在浏览器里很难被观测到 —— 只有"写接口 + 只读环境"同时成立
 * 才会抛错，而只读环境下 UI 早已把入口拦住，正常操作走不到这里。
 * 没有这个用例，谁把 guardWrite 删了都不会有测试变红。
 *
 * 用与 dict-value-sync.test.cjs 相同的做法：从 content.js 里切出真实函数体，
 * 在 vm 里配上桩来跑，保证测的是**线上那份代码**，而不是复制品。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('  function guardWrite(');
const end = source.indexOf('  async function callApi(', start);
assert.ok(start >= 0 && end > start, '未能从 content.js 中切出 guardWrite');

const guardSource = source.slice(start, end);

/** @param {string} blocked writeBlockedReason 的返回值（'' = 可写） */
function createGuard(blocked, overrides = {}) {
  const EnvGuard = Object.assign({
    // 真实规则：只有 add/edit 这类算写
    isWritePath: (p) => /(add|edit|update|save|delete|remove|create|modify|import|submit)/i.test(String(p || ''))
  }, overrides);
  const context = vm.createContext({
    EnvGuard,
    writeBlockedReason: () => blocked,
  });
  vm.runInContext(guardSource, context);
  return context.guardWrite;
}

const REASON = '「auth.joyintoy.cn」是生产环境，默认只读、禁止写入。';

test('只读环境下：写接口被拦，且错误信息带上原因', () => {
  const guard = createGuard(REASON);
  assert.throws(() => guard('/base/dictData/add'), /已阻止写入/);
  assert.throws(() => guard('/base/dictData/add'), new RegExp('生产环境'));
  assert.throws(() => guard('/base/dictType/edit'), /已阻止写入/);
});

test('只读环境下：读接口必须放行（只读是"不能改"，不是"不能用"）', () => {
  const guard = createGuard(REASON);
  // 这几条一旦被判成写，生产上连数据都看不到
  assert.doesNotThrow(() => guard('/base/dictType/listPage'));
  assert.doesNotThrow(() => guard('/base/dictData/listPage'));
  assert.doesNotThrow(() => guard('/base/dictData/listPage?pageNum=1'));
});

test('可写环境下：写接口放行（限制不能扩大到测试环境）', () => {
  const guard = createGuard('');   // writeBlockedReason 返回空 = 可写
  assert.doesNotThrow(() => guard('/base/dictData/add'));
  assert.doesNotThrow(() => guard('/base/dictType/edit'));
  assert.doesNotThrow(() => guard('/base/dictType/listPage'));
});

test('可写环境下：即使分类错误地把读当写，也不会误拦（提前返回）', () => {
  // 钉住短路顺序：先看环境，再看是不是写。反过来的实现会在可写环境上
  // 因为分类函数抛错/副作用而误拦，这里用"分类永远为真"来暴露
  const guard = createGuard('', { isWritePath: () => true });
  assert.doesNotThrow(() => guard('/base/dictData/listPage'));
});

test('只读环境下：分类为读时不得抛错（即使环境只读）', () => {
  const guard = createGuard(REASON, { isWritePath: () => false });
  assert.doesNotThrow(() => guard('/base/dictData/add'));
});
