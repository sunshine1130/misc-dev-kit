'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// 执行 content.js 中真实的同步函数，隔离浏览器面板和网络通信。
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const start = source.indexOf('  async function searchDictType(');
const end = source.indexOf('  // ==================== 删除选中', start);
assert.ok(start >= 0 && end > start);

function createContext(callApi, values = []) {
  const context = vm.createContext({
    callApi,
    capturedDictTypes: [],
    capturedDictValues: [{ dictTypeId: 'source-unit', dictType: 'unit', values }],
    syncStatus: 'idle',
    syncStats: { ok: 0, warn: 0, err: 0 },
    syncLog: [],
    countSelectedTypes: () => 0,
    countSelectedValues: () => values.length,
    resetStats() {},
    refreshPanel() {},
    log() {},
    addLog() {},
    ensureApiBaseOrigin: async () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  context.sleep = async () => {};
  return context;
}

function listResponse(list, total = list.length) {
  return { code: 200, data: { list, total } };
}

async function syncValues(target, values, queryResponse) {
  const calls = [];
  const context = createContext(async (api, data) => {
    calls.push({ api, data });
    if (api === '/base/dictType/listPage') {
      return listResponse([{ id: 'target-unit', dictType: 'unit' }]);
    }
    if (api === '/base/dictData/listPage') {
      assert.equal(data.dictTypeId, 'target-unit');
      assert.equal(Object.hasOwn(data, 'dictLabel'), false);
      return queryResponse || listResponse(target);
    }
    return { code: 200 };
  }, values);
  await context.syncSelected();
  return calls.filter(({ api }) => /\/dictData\/(add|edit)$/.test(api));
}

test('same value with different label updates the target ID; missing month is added', async () => {
  const writes = await syncValues(
    [{ id: 'target-year', dictLabel: '年岁', dictValue: 'year' }],
    [{ id: 'source-year', dictLabel: '岁', dictValue: 'year' },
      { id: 'source-month', dictLabel: '月份', dictValue: 'month' }],
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].api, '/base/dictData/edit');
  assert.equal(writes[0].data.id, 'target-year');
  assert.equal(writes[0].data.dictLabel, '岁');
  assert.equal(writes[0].data.dictValue, 'year');
  assert.equal(writes[1].api, '/base/dictData/add');
  assert.equal(writes[1].data.dictValue, 'month');
  assert.equal(Object.hasOwn(writes[1].data, 'id'), false);
});

test('same label with different value does not overwrite an unrelated value', async () => {
  const writes = await syncValues(
    [{ id: 'target-month', dictLabel: '岁', dictValue: 'month' }],
    [{ dictLabel: '岁', dictValue: 'year' }],
  );
  assert.equal(writes[0].api, '/base/dictData/add');
});

test('fuzzy results require an exact value match rather than the first row', async () => {
  const writes = await syncValues(
    [{ id: 'other', dictValue: 'yearly' }, { id: 'exact', dictValue: 'year' }],
    [{ dictLabel: '岁', dictValue: 'year' }],
  );
  assert.equal(writes[0].api, '/base/dictData/edit');
  assert.equal(writes[0].data.id, 'exact');
});

test('exact match can be found on a later result page', async () => {
  const pages = [];
  const context = createContext(async (api, data) => {
    pages.push(data.pageNum);
    assert.equal(data.dictValue, 'year');
    return data.pageNum === 1
      ? listResponse(Array.from({ length: 100 }, (_, i) => ({ dictValue: 'year-' + i })), 101)
      : listResponse([{ id: 'exact', dictValue: 'year' }], 101);
  });
  assert.equal((await context.searchDictValue('target-unit', 'year')).id, 'exact');
  assert.deepEqual(pages, [1, 2]);
});

test('zero values match between numeric and string API representations', async () => {
  const context = createContext(async () => listResponse([{ id: 'zero', dictValue: 0 }]));
  assert.equal((await context.searchDictValue('target-unit', '0')).id, 'zero');
});

test('failed or malformed queries do not fall through to adding a duplicate', async () => {
  for (const response of [{ code: 500 }, { code: 200, data: {} }]) {
    const writes = await syncValues([], [{ dictLabel: '岁', dictValue: 'year' }], response);
    assert.equal(writes.length, 0);
  }
});
