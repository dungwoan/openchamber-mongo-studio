import { describe, expect, test } from 'bun:test';

import { components, groupShards, layout, neighborhood, searchNames } from './diagram-layout.ts';

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('components', () => {
  test('đồ thị rỗng → không có thành phần', () => {
    expect(components([], [])).toEqual([]);
  });

  test('không liên thông: tách thành các thành phần, cạnh tới id lạ bị bỏ', () => {
    const parts = components(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'c', to: 'zzz' }]);
    expect(parts.map((p) => [...p].sort())).toEqual([['a', 'b'], ['c'], ['d']]);
  });
});

describe('layout', () => {
  test('đồ thị rỗng → bản đồ rỗng', () => {
    expect(layout([], []).size).toBe(0);
  });

  test('một bảng đứng riêng, toạ độ hữu hạn', () => {
    const pos = layout([{ id: 'a', width: 200, height: 100 }], []);
    expect(Number.isFinite(pos.get('a')?.x)).toBe(true);
    expect(pos.get('a')?.y).toBeDefined();
  });

  test('không chồng thẻ, kể cả khi có nhiều thành phần và nhiều cạnh', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, width: 220, height: 40 + (i % 5) * 30 }));
    const edges = [
      ...Array.from({ length: 20 }, (_, i) => ({ from: `n${i}`, to: `n${(i * 7 + 3) % 30}` })),
      { from: 'n28', to: 'n29' },
    ];
    const pos = layout(nodes, edges);
    const boxes = nodes.map((n) => ({ ...pos.get(n.id)!, width: n.width, height: n.height }));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlap(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  test('nhiều thành phần rời nhau xuống hàng, không kéo dài một hàng ngang', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, width: 230, height: 60 }));
    const pos = layout(nodes, []);
    const maxRight = Math.max(...nodes.map((n) => (pos.get(n.id)?.x ?? 0) + n.width));
    const maxBottom = Math.max(...nodes.map((n) => (pos.get(n.id)?.y ?? 0) + n.height));
    expect(maxRight).toBeLessThanOrEqual(1400);
    expect(maxBottom).toBeGreaterThan(60);
  });

  test('thành phần liên thông nằm cạnh nhau theo cột (cạnh đi từ trái sang phải)', () => {
    const pos = layout(
      [{ id: 'a', width: 100, height: 50 }, { id: 'b', width: 100, height: 50 }],
      [{ from: 'a', to: 'b' }],
    );
    expect(pos.get('b')!.x).toBeGreaterThan(pos.get('a')!.x);
  });
});

describe('neighborhood', () => {
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'x', to: 'y' }];
  test('1 bước lấy hàng xóm trực tiếp (hai chiều)', () => {
    expect([...neighborhood(edges, 'b', 1)].sort()).toEqual(['a', 'b', 'c']);
  });
  test('2 bước lan xa hơn, không vượt thành phần', () => {
    expect([...neighborhood(edges, 'b', 2)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  test('id không tồn tại → chỉ chính nó', () => {
    expect([...neighborhood(edges, 'nope', 2)]).toEqual(['nope']);
  });
});

describe('groupShards', () => {
  test('từ 2 bảng cdr_* trở lên gộp thành một nhóm "cdr_*"; bảng khác giữ nguyên', () => {
    const groups = groupShards(['customers', 'cdr_20260101', 'cdr_20260102', 'cdr', 'audit_logs']);
    const shard = groups.find((g) => g.id === 'cdr_*');
    expect(shard?.members).toEqual(['cdr_20260101', 'cdr_20260102']);
    expect(groups.filter((g) => g.id !== 'cdr_*').map((g) => g.id).sort()).toEqual(['audit_logs', 'cdr', 'customers']);
  });

  test('chỉ một bảng cdr_* thì không gộp', () => {
    const groups = groupShards(['cdr_20260101']);
    expect(groups).toEqual([{ id: 'cdr_20260101', label: 'cdr_20260101', members: ['cdr_20260101'] }]);
  });
});

describe('searchNames', () => {
  test('không phân biệt hoa thường, rỗng thì không lọc', () => {
    expect(searchNames(['Customers', 'orders'], 'CUST')).toEqual(['Customers']);
    expect(searchNames(['a', 'b'], '  ')).toEqual(['a', 'b']);
  });
});

import { applyOverrides, edgeGeometry, filterRelations } from './diagram-layout.ts';

describe('edgeGeometry (cạnh nối giữa hai thẻ)', () => {
  test('nối từ cạnh phải của thẻ trái sang cạnh trái của thẻ phải, tại tâm chiều cao', () => {
    const g = edgeGeometry({ x: 0, y: 0, width: 100, height: 50 }, { x: 200, y: 100, width: 100, height: 50 });
    expect(g.d.startsWith('M 100 25 ')).toBe(true);
    expect(g.d.endsWith(' 200 125')).toBe(true);
    expect(g.labelX).toBeGreaterThan(100);
    expect(g.labelX).toBeLessThan(200);
  });

  test('thẻ đích nằm bên trái: nối từ cạnh trái sang cạnh phải', () => {
    const g = edgeGeometry({ x: 300, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 });
    expect(g.d.startsWith('M 300 25 ')).toBe(true);
    expect(g.d.endsWith(' 100 25')).toBe(true);
  });
});

describe('applyOverrides (kéo thẻ không đổi bố cục gốc)', () => {
  test('thẻ được kéo dùng vị trí mới, thẻ khác giữ nguyên, bản gốc không bị sửa', () => {
    const base = new Map([['a', { x: 0, y: 0 }], ['b', { x: 10, y: 10 }]]);
    const moved = applyOverrides(base, new Map([['b', { x: 500, y: 300 }]]));
    expect(moved.get('a')).toEqual({ x: 0, y: 0 });
    expect(moved.get('b')).toEqual({ x: 500, y: 300 });
    expect(base.get('b')).toEqual({ x: 10, y: 10 });
  });
});

describe('filterRelations (Hiển thị quan hệ bật/tắt)', () => {
  const list = [
    { id: 1, confidence: 'declared' as const },
    { id: 2, confidence: 'inferred' as const },
  ];
  test('bật: giữ cả khai báo lẫn suy đoán', () => {
    expect(filterRelations(list, true)).toHaveLength(2);
  });
  test('tắt: không còn quan hệ nào; bật lại thì trở về đầy đủ', () => {
    expect(filterRelations(list, false)).toHaveLength(0);
    expect(filterRelations(list, true)).toHaveLength(2);
  });
});

import { resolveDrop } from './diagram-layout.ts';

const sized = (ids: Array<[string, number, number, number, number]>) => ({
  positions: new Map(ids.map(([id, x, y]) => [id, { x, y }] as const)),
  sizes: new Map(ids.map(([id, , , w, h]) => [id, { width: w, height: h }] as const)),
});
const conflictsAny = (positions: Map<string, { x: number; y: number }>, sizes: Map<string, { width: number; height: number }>, id: string, gap = 16): boolean => {
  const p = positions.get(id)!;
  const s = sizes.get(id)!;
  return [...positions].some(([other, q]) => {
    if (other === id) return false;
    const t = sizes.get(other)!;
    return p.x < q.x + t.width + gap && q.x < p.x + s.width + gap && p.y < q.y + t.height + gap && q.y < p.y + s.height + gap;
  });
};

describe('resolveDrop (thả thẻ không đè thẻ khác)', () => {
  test('không đè ai thì giữ nguyên vị trí', () => {
    const { positions, sizes } = sized([['a', 0, 0, 100, 50], ['b', 400, 0, 100, 50]]);
    expect(resolveDrop('a', positions, sizes)).toEqual({ x: 0, y: 0 });
  });

  test('cách đúng 16 px vẫn được coi là không đè', () => {
    const { positions, sizes } = sized([['a', 0, 0, 100, 50], ['b', 116, 0, 100, 50]]);
    expect(resolveDrop('a', positions, sizes)).toEqual({ x: 0, y: 0 });
  });

  test('đè lên thẻ khác thì dời sang vị trí trống gần nhất, không đè và cách tối thiểu 16 px', () => {
    const { positions, sizes } = sized([['a', 0, 0, 100, 50], ['b', 300, 300, 100, 50]]);
    positions.set('a', { x: 310, y: 310 });
    const moved = resolveDrop('a', positions, sizes);
    expect(moved).not.toEqual({ x: 310, y: 310 });
    positions.set('a', moved);
    expect(conflictsAny(positions, sizes, 'a')).toBe(false);
  });

  test('vị trí mới là vị trí trống gần nhất (không xa hơn cần thiết)', () => {
    const { positions, sizes } = sized([['a', 0, 0, 100, 50], ['b', 200, 0, 100, 50]]);
    positions.set('a', { x: 205, y: 0 });
    const moved = resolveDrop('a', positions, sizes);
    // Ngay dưới b (y = 50 + 16 = 66), giữ x của điểm thả: cách điểm thả 66 px, gần hơn mọi vị trí khác (kể cả bên phải, 316, 0).
    expect(moved).toEqual({ x: 205, y: 66 });
    positions.set('a', moved);
    expect(conflictsAny(positions, sizes, 'a')).toBe(false);
  });

  test('nhiều thẻ thả liên tiếp đè nhau: sau mỗi lần thả không còn chồng', () => {
    const ids: Array<[string, number, number, number, number]> = Array.from({ length: 8 }, (_, i) => [`t${i}`, i * 300, 0, 240, 120]);
    const { positions, sizes } = sized(ids);
    for (let i = 1; i < 8; i += 1) {
      positions.set(`t${i}`, { x: 40, y: 20 }); // mọi thẻ được kéo về cùng một chỗ
      positions.set(`t${i}`, resolveDrop(`t${i}`, positions, sizes));
      expect(conflictsAny(positions, sizes, `t${i}`)).toBe(false);
    }
  });

  test('bảng lớn: 80 thẻ, thả một thẻ vào giữa lưới thì không đè thẻ nào', () => {
    const ids: Array<[string, number, number, number, number]> = [];
    for (let i = 0; i < 80; i += 1) ids.push([`b${i}`, (i % 10) * 260, Math.floor(i / 10) * 200, 240, 170]);
    const { positions, sizes } = sized(ids);
    positions.set('b44', { x: 520, y: 400 });
    positions.set('b44', resolveDrop('b44', positions, sizes));
    expect(conflictsAny(positions, sizes, 'b44')).toBe(false);
  });

  test('thẻ không có kích thước hoặc không có vị trí thì trả về vị trí hiện có, không lỗi', () => {
    const { positions, sizes } = sized([['a', 5, 5, 100, 50]]);
    expect(resolveDrop('zzz', positions, sizes)).toEqual({ x: 0, y: 0 });
  });
});

import { CARD_FIELDS_SHOWN, CARD_HEADER, CARD_ROW, cardHeightFor, fieldWindow } from './diagram-layout.ts';

describe('fieldWindow (thẻ có hơn 12 field: +N more / thu gọn)', () => {
  test('thu gọn: hiện 12 field đầu, còn lại là số ẩn; có nút', () => {
    expect(fieldWindow(15, false)).toEqual({ shown: 12, hidden: 3, collapsible: true });
  });
  test('mở rộng: hiện đủ field; nút vẫn có (để thu gọn)', () => {
    expect(fieldWindow(15, true)).toEqual({ shown: 15, hidden: 0, collapsible: true });
  });
  test('không quá 12 field: không có nút, dù đang ở trạng thái mở rộng', () => {
    expect(fieldWindow(5, false)).toEqual({ shown: 5, hidden: 0, collapsible: false });
    expect(fieldWindow(12, true)).toEqual({ shown: 12, hidden: 0, collapsible: false });
  });
  test('mặc định cắt ở CARD_FIELDS_SHOWN', () => {
    expect(CARD_FIELDS_SHOWN).toBe(12);
    expect(fieldWindow(13, false).shown).toBe(CARD_FIELDS_SHOWN);
  });
});

describe('cardHeightFor (chiều cao thẻ theo số dòng hiện)', () => {
  test('mở rộng cao hơn thu gọn đúng bằng số dòng thêm', () => {
    expect(cardHeightFor(15, true) - cardHeightFor(12, true)).toBe(3 * CARD_ROW);
  });
  test('field cuối và dòng nút nằm gọn trong khung', () => {
    const n = 15;
    const controlBottom = CARD_HEADER + 6 + (n + 1) * CARD_ROW;
    expect(cardHeightFor(n, true)).toBeGreaterThanOrEqual(controlBottom);
  });
  test('không có nút thì không có dòng nút thừa', () => {
    expect(cardHeightFor(5, false)).toBe(CARD_HEADER + 6 + 5 * CARD_ROW + 6);
  });
});

describe('hình học cạnh khi thẻ mở rộng', () => {
  test('cạnh xuất phát đúng tâm chiều cao của thẻ đã mở rộng', () => {
    const h = cardHeightFor(15, true);
    const g = edgeGeometry({ x: 0, y: 0, width: 240, height: h }, { x: 400, y: 0, width: 240, height: 100 });
    expect(g.d.startsWith(`M 240 ${h / 2} `)).toBe(true);
  });
});
