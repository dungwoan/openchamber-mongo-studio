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
