'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch, layoutMaxSets } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');

const EPS = 1e-6;

/** 逐张校验：纸上各品种件数严格等于 每套用量 × 本张套数（无半套） */
function assertSheetCompleteSets(sheets, perSetById) {
  for (const sh of sheets) {
    const layout = sh.layout || sh; // 成本模式为 sh.layout，批量模式即 sh
    const sets = sh.sets;
    assert.ok(Number.isInteger(sets) && sets >= 1, '每张提交的纸至少含一整套');
    const countById = {};
    for (const it of layout.items) {
      countById[it.id] = (countById[it.id] || 0) + 1;
    }
    for (const [id, perSet] of Object.entries(perSetById)) {
      assert.strictEqual(
        countById[id] || 0,
        perSet * sets,
        `品种 ${id} 必须恰好排 每套用量×套数 件（禁止半套）`
      );
    }
    // 不多排任何品种
    assert.strictEqual(Object.keys(countById).length, Object.keys(perSetById).length);
  }
}

/* ---------------- 单张成套试排（layoutMaxSets） ---------------- */

test('成套试排：面积上界内取最多完整套数，且不超过剩余套数上限', () => {
  const rows = [
    { id: 'A', name: '', width: 100, height: 100, grain: 'any', orderNo: null, perSet: 1 },
    { id: 'B', name: '', width: 100, height: 100, grain: 'any', orderNo: null, perSet: 1 },
  ];
  // 400×400 恰好 16 格 → 8 套（16 件）
  const full = layoutMaxSets({ paperW: 400, paperH: 400, kerf: 0 }, rows, 10);
  assert.strictEqual(full.sets, 8);
  assert.strictEqual(full.result.stats.piecesPlaced, 16);
  // 剩余套数上限封顶
  const capped = layoutMaxSets({ paperW: 400, paperH: 400, kerf: 0 }, rows, 3);
  assert.strictEqual(capped.sets, 3);
  assert.strictEqual(capped.result.stats.piecesPlaced, 6);
});

test('成套试排：刀缝占用使套数下降时二分取最大可行套数', () => {
  const rows = [
    { id: 'A', name: '', width: 100, height: 100, grain: 'any', orderNo: null, perSet: 1 },
    { id: 'B', name: '', width: 100, height: 100, grain: 'any', orderNo: null, perSet: 1 },
  ];
  // 406×406、kerf 3：每行/列最多 3 件（4×100+3×3=409>406）→ 3×3=9 件 → 4 套
  const r = layoutMaxSets({ paperW: 406, paperH: 406, kerf: 3 }, rows, 10);
  assert.strictEqual(r.sets, 4);
  assert.strictEqual(r.result.stats.piecesPlaced, 8);
});

test('成套试排：组不成一整套时 sets=0 且给出 k=1 诊断（不提交）', () => {
  const r = layoutMaxSets({ paperW: 200, paperH: 200, kerf: 0 }, [
    { id: 'A', name: '', width: 100, height: 100, grain: 'any', orderNo: null, perSet: 1 },
    { id: 'B', name: '', width: 300, height: 300, grain: 'any', orderNo: null, perSet: 1 },
  ], 5);
  assert.strictEqual(r.sets, 0);
  const big = r.result.unplaced.find((u) => u.id === 'B');
  assert.strictEqual(big.quantity, 1);
  assert.strictEqual(big.grainBlocked, false); // 纯尺寸不足
});

/* ---------------- 批量成套排产 ---------------- */

test('批量成套：逐张只含完整套，完成套数与各品种已排/欠数守恒', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 100, kerf: 0, maxSheets: 10,
    setMode: true, setCount: 5,
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 50, height: 100, perSet: 2 },
    ],
  });
  assert.strictEqual(r.setMode, true);
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.summary.setsPlanned, 5);
  assert.strictEqual(r.summary.setsCompleted, 5);
  assert.strictEqual(r.summary.setCompletionRate, 1);
  assert.strictEqual(r.summary.sheetsUsed, 5); // 每张恰好 1 套铺满
  assertSheetCompleteSets(r.sheets, { P1: 1, P2: 2 });
  // 各品种：套内需求 perSet、总需求 = perSet×计划套数、已排 = perSet×完成套数
  const a = r.setSummary.find((s) => s.id === 'P1');
  const b = r.setSummary.find((s) => s.id === 'P2');
  assert.deepStrictEqual([a.perSet, a.total, a.placed, a.quantity], [1, 5, 5, 0]);
  assert.deepStrictEqual([b.perSet, b.total, b.placed, b.quantity], [2, 10, 10, 0]);
  assert.strictEqual(r.remaining.length, 0);
  // 件数汇总守恒
  assert.strictEqual(r.summary.piecesTotal, 15);
  assert.strictEqual(r.summary.piecesPlaced, 15);
});

test('批量成套：禁止贪心多排某一品种形成半套', () => {
  // 300×100 可放 3 件 100×100；成套比例 1A:2B → 每张只能提交 1 套（3 件），
  // 绝不多排第 2 件 A 形成无法交付的半套
  const r = layoutBatch({
    paperW: 300, paperH: 100, kerf: 0, maxSheets: 10,
    setMode: true, setCount: 2,
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 2 },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 2);
  assertSheetCompleteSets(r.sheets, { P1: 1, P2: 2 });
  for (const sh of r.sheets) {
    assert.strictEqual(sh.sets, 1);
    assert.strictEqual(sh.stats.piecesPlaced, 3);
  }
});

test('批量成套：达到用纸上限即停，完成套数与欠数正确', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 100, kerf: 0, maxSheets: 2,
    setMode: true, setCount: 5,
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 50, height: 100, perSet: 2 },
    ],
  });
  assert.strictEqual(r.stopReason, 'max-sheets');
  assert.strictEqual(r.summary.sheetsUsed, 2);
  assert.strictEqual(r.summary.setsCompleted, 2);
  assert.ok(r.summary.setCompletionRate > 0 && r.summary.setCompletionRate < 1);
  const a = r.remaining.find((u) => u.id === 'P1');
  const b = r.remaining.find((u) => u.id === 'P2');
  assert.deepStrictEqual([a.perSet, a.total, a.placed, a.quantity], [1, 5, 2, 3]);
  assert.deepStrictEqual([b.perSet, b.total, b.placed, a.quantity - 1], [2, 10, 4, 2]);
});

test('批量成套：组不成一整套时 no-progress，本轮不提交纸张', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 5,
    setMode: true, setCount: 2,
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 300, height: 300, perSet: 1 }, // 永远排不进
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0); // 空白纸不计入
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.summary.setsCompleted, 0);
  assert.strictEqual(r.summary.piecesPlaced, 0);
  // 剩余即全部需求（未误扣）
  const a = r.remaining.find((u) => u.id === 'P1');
  const b = r.remaining.find((u) => u.id === 'P2');
  assert.deepStrictEqual([a.total, a.placed, a.quantity], [2, 0, 2]);
  assert.deepStrictEqual([b.total, b.placed, b.quantity], [2, 0, 2]);
});

test('批量成套：部分完成后材料组不成一整套，保留已排并止损', () => {
  // 每张 1 套；第 3 张起 B 已排完、A 单品种凑不成套（perSet 比例 1:1）→
  // 实际构造：计划 3 套，但 B 的总需求只有 2 套份量？不允许——成套需求恒为
  // perSet×setCount，故改为：纸面排 1 套后余料不足以再排整套的情形由
  // maxSheets 覆盖；这里验证纹向受阻导致的 no-progress 保留已排纸张。
  const r = layoutBatch({
    paperW: 100, paperH: 300, kerf: 0, maxSheets: 5, paperGrain: 'along-width',
    setMode: true, setCount: 2,
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 }, // 可排
      { name: 'B', width: 120, height: 40, perSet: 1, grain: 'along-width' }, // 纹向受阻
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  const b = r.remaining.find((u) => u.id === 'P2');
  assert.strictEqual(b.grainBlocked, true); // 几何能放下但纹向不允许
  const a = r.remaining.find((u) => u.id === 'P1');
  assert.strictEqual(a.grainBlocked, false);
});

test('批量成套：每套用量全为 0 时直接完成、不用纸', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 5,
    setMode: true, setCount: 3,
    products: [{ name: 'A', width: 100, height: 100, perSet: 0 }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.setsCompleted, 3);
  assert.strictEqual(r.summary.setCompletionRate, 1);
});

test('批量成套：入参校验（套数/每套用量/开关/与订单隔离互斥）', () => {
  const base = {
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 2,
    setMode: true, setCount: 2,
    products: [{ width: 100, height: 100, perSet: 1 }],
  };
  // 计划套数
  assert.throws(() => layoutBatch({ ...base, setCount: undefined }), /计划套数/);
  assert.throws(() => layoutBatch({ ...base, setCount: 0 }), /计划套数/);
  assert.throws(() => layoutBatch({ ...base, setCount: 1.5 }), /计划套数/);
  assert.throws(() => layoutBatch({ ...base, setCount: 501 }), /计划套数/);
  // setMode 必须为布尔
  assert.throws(() => layoutBatch({ ...base, setMode: 'yes' }), /setMode/);
  // 每套用量
  assert.throws(() => layoutBatch({
    ...base, products: [{ width: 100, height: 100 }],
  }), /每套用量/);
  assert.throws(() => layoutBatch({
    ...base, products: [{ width: 100, height: 100, perSet: -1 }],
  }), /每套用量/);
  assert.throws(() => layoutBatch({
    ...base, products: [{ width: 100, height: 100, perSet: 0.5 }],
  }), /每套用量/);
  // 与订单隔离互斥
  assert.throws(() => layoutBatch({ ...base, isolateOrders: true }), /订单隔离/);
  // 非成套请求保持旧行为：不带 setMode 字段
  const plain = layoutBatch({
    paperW: 200, paperH: 200, kerf: 0, maxSheets: 2,
    products: [{ width: 100, height: 100, quantity: 2 }],
  });
  assert.strictEqual('setMode' in plain, false);
  assert.strictEqual('setSummary' in plain, false);
});

/* ---------------- 多纸型成本成套排产 ---------------- */

test('成本成套：完整套数多者优先，哪怕单位面积成本更高', () => {
  // 纸X 200×100 每张 1 套、单位成本 1/20000；纸Y 400×100 每张 2 套、
  // 单位成本 3/40000（更贵）。非成套成本模式会选 X，成套模式套数优先选 Y。
  const r = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 2,
    papers: [
      { name: '纸X', width: 200, height: 100, price: 1, stock: 5 },
      { name: '纸Y', width: 400, height: 100, price: 3, stock: 5 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 1 },
    ],
  });
  assert.strictEqual(r.setMode, true);
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 1);
  assert.strictEqual(r.sheets[0].paperId, 'S2');
  assert.strictEqual(r.sheets[0].sets, 2);
  assert.strictEqual(r.summary.setsCompleted, 2);
  // 候选排名带套数，胜者套数最多
  const ranked = r.sheets[0].selection.ranked;
  assert.strictEqual(ranked.find((c) => c.paperId === 'S2').sets, 2);
  assert.strictEqual(ranked.find((c) => c.paperId === 'S1').sets, 1);
  assert.strictEqual(ranked.find((c) => c.selected).paperId, 'S2');
});

test('成本成套：同套数时按单位已排面积成本、再按录入顺序决胜', () => {
  // 两种纸每张都是 1 套：单价低者胜
  const r = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 1,
    papers: [
      { name: '贵纸', width: 200, height: 100, price: 2, stock: 5 },
      { name: '廉纸', width: 200, height: 100, price: 1, stock: 5 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 1 },
    ],
  });
  assert.strictEqual(r.sheets[0].paperId, 'S2');
  // 全部指标相同（同尺寸同单价同套数）→ 录入顺序靠前者
  const r2 = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 1,
    papers: [
      { name: '先录入', width: 200, height: 100, price: 1, stock: 5 },
      { name: '后录入', width: 200, height: 100, price: 1, stock: 5 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 1 },
    ],
  });
  assert.strictEqual(r2.sheets[0].paperId, 'S1');
});

test('成本成套：逐张严格整套，库存与套数扣减守恒', () => {
  const r = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 4,
    papers: [
      { name: '纸A', width: 400, height: 100, price: 3, stock: 2 }, // 每张 2 套
      { name: '纸B', width: 200, height: 100, price: 1.2, stock: 5 }, // 每张 1 套
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.summary.setsCompleted, 4);
  assertSheetCompleteSets(r.sheets, { P1: 1, P2: 1 });
  // 库存守恒：已用 = 用纸数，剩余 = 库存 - 已用
  const usedSum = r.usage.reduce((s, u) => s + u.used, 0);
  assert.strictEqual(usedSum, r.sheets.length);
  for (const u of r.usage) assert.strictEqual(u.remainingStock, u.stock - u.used);
  // 各品种：已排 = perSet×完成套数，欠数 = 总需求 - 已排
  for (const s of r.setSummary) {
    assert.strictEqual(s.placed, s.perSet * 4);
    assert.strictEqual(s.quantity, s.total - s.placed);
  }
  // 完成套数 = 各张套数之和
  assert.strictEqual(
    r.sheets.reduce((s, sh) => s + sh.sets, 0),
    r.summary.setsCompleted
  );
});

test('成本成套：组不成一整套时 no-progress，本轮不扣库存', () => {
  const r = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 2,
    papers: [
      { name: '小纸A', width: 200, height: 200, price: 1, stock: 3 },
      { name: '小纸B', width: 150, height: 150, price: 0.5, stock: 3 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 500, height: 500, perSet: 1 }, // 任何纸都组不成套
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.summary.setsCompleted, 0);
  // 不扣库存
  assert.deepStrictEqual(r.usage.map((u) => u.remainingStock), [3, 3]);
  // 各品种欠数 = 全部需求
  const b = r.remaining.find((u) => u.id === 'P2');
  assert.deepStrictEqual([b.total, b.placed, b.quantity], [2, 0, 2]);
});

test('成本成套：库存耗尽即停，完成套数与欠数正确', () => {
  const r = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 5,
    papers: [
      { name: '纸A', width: 200, height: 100, price: 1, stock: 1 }, // 每张 1 套
      { name: '纸B', width: 200, height: 100, price: 1, stock: 1 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'stock-exhausted');
  assert.strictEqual(r.sheets.length, 2);
  assert.strictEqual(r.summary.setsCompleted, 2);
  const a = r.remaining.find((u) => u.id === 'P1');
  assert.deepStrictEqual([a.total, a.placed, a.quantity], [5, 2, 3]);
  assert.deepStrictEqual(r.usage.map((u) => u.remainingStock), [0, 0]);
});

test('成本成套：候选套数受剩余套数封顶，不超产', () => {
  // 大纸单张可排 4 套，但只剩 3 套需求 → 本张只排 3 套
  const r = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 3,
    papers: [
      { name: '大纸', width: 400, height: 400, price: 5, stock: 2 },
      { name: '小纸', width: 200, height: 100, price: 1, stock: 5 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 100, perSet: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 1);
  assert.strictEqual(r.sheets[0].sets, 3); // 不是面积上界的 8 套
  assert.strictEqual(r.summary.piecesPlaced, 6);
  assert.strictEqual(r.remaining.length, 0);
});

test('成本成套：空需求直接完成，校验与非成套兼容', () => {
  const papers = [
    { name: 'A', width: 100, height: 100, price: 1, stock: 2 },
    { name: 'B', width: 200, height: 200, price: 2, stock: 2 },
  ];
  const empty = layoutCostBatch({
    kerf: 0, setMode: true, setCount: 4, papers, products: [],
  });
  assert.strictEqual(empty.stopReason, 'completed');
  assert.strictEqual(empty.sheets.length, 0);
  assert.strictEqual(empty.summary.setsCompleted, 4);
  assert.deepStrictEqual(empty.setSummary, []);

  // 校验
  assert.throws(() => layoutCostBatch({
    kerf: 0, setMode: true, papers,
    products: [{ width: 100, height: 100, perSet: 1 }],
  }), /计划套数/);
  assert.throws(() => layoutCostBatch({
    kerf: 0, setMode: true, setCount: 2, papers,
    products: [{ width: 100, height: 100, quantity: 2 }],
  }), /每套用量/);
  assert.throws(() => layoutCostBatch({
    kerf: 0, setMode: true, setCount: 2, isolateOrders: true, papers,
    products: [{ width: 100, height: 100, perSet: 1 }],
  }), /订单隔离/);
  // 非成套请求不带成套字段
  const plain = layoutCostBatch({
    kerf: 0, papers,
    products: [{ width: 100, height: 100, quantity: 2 }],
  });
  assert.strictEqual('setMode' in plain, false);
  assert.strictEqual('setSummary' in plain, false);
});

test('成本成套：每张布局仍是合法单张布局（纸面内、不重叠）', () => {
  const r = layoutCostBatch({
    kerf: 3, setMode: true, setCount: 6,
    papers: [
      { name: '纸A', width: 406, height: 406, price: 4, stock: 3 },
      { name: '纸B', width: 300, height: 300, price: 2, stock: 3 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 100, height: 50, perSet: 2 },
    ],
  });
  assert.ok(r.sheets.length > 0);
  for (const sh of r.sheets) {
    for (const it of sh.layout.items) {
      assert.ok(it.x >= -EPS && it.y >= -EPS);
      assert.ok(it.x + it.w <= sh.paperWidth + EPS && it.y + it.h <= sh.paperHeight + EPS);
    }
    const items = sh.layout.items;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const overlap = !(
          a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS ||
          a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS
        );
        assert.ok(!overlap, '成品间不应重叠');
      }
    }
  }
  assertSheetCompleteSets(r.sheets, { P1: 1, P2: 2 });
});
