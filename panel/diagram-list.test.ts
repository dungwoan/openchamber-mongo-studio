import { describe, expect, test } from 'bun:test';

import { diagramEntries } from './diagram-list.ts';

describe('diagramEntries (mục Diagrams trong cột trái)', () => {
  test('không có dự án và không có tab nào → không có mục', () => {
    expect(diagramEntries(null, [])).toEqual([]);
  });

  test('dự án đang mở đứng đầu và được đánh dấu; tab sơ đồ của dự án khác nối sau, không trùng', () => {
    expect(diagramEntries('/home/u/proj', ['/home/u/other', '/home/u/proj'])).toEqual([
      { directory: '/home/u/proj', label: 'proj', current: true },
      { directory: '/home/u/other', label: 'other', current: false },
    ]);
  });

  test('chỉ có tab của dự án khác (đã đổi sang dự án không có tab) vẫn liệt kê', () => {
    expect(diagramEntries(null, ['/srv/app/'])).toEqual([{ directory: '/srv/app/', label: 'app', current: false }]);
  });
});
