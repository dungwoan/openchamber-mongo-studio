/**
 * Hiển thị kết quả dạng Table, JSON hoặc Tree. Dùng chung cho tab Collection và tab Query.
 */
import { mountButton } from '@openchamber/sdk/ui';

import { cellText, prettyJson, treeNode } from './format.ts';
import { h, slot } from './dom.ts';

export type ViewMode = 'table' | 'json' | 'tree';

/** Thao tác trên một document; mỗi thao tác là tuỳ chọn (không có thì không hiện nút). */
export type RowActions = {
  edit?: (doc: Record<string, unknown>) => void;
  remove?: (doc: Record<string, unknown>) => void;
  copy: (doc: unknown) => void;
};

const MAX_COLUMNS = 30;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Danh sách cột: _id đứng đầu, rồi các khoá theo thứ tự xuất hiện. */
export function columnsOf(docs: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) seen.add(key);
  }
  const ordered = [...seen].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
  return ordered.slice(0, MAX_COLUMNS);
}

function actionRow(doc: Record<string, unknown>, actions: RowActions): HTMLElement {
  const row = h('div', 'ms-row-actions');
  if (actions.edit) {
    const edit = slot('ms-slot ms-slot-inline');
    row.appendChild(edit);
    mountButton(edit, { label: 'Edit', variant: 'outline', size: 'xs', onClick: () => actions.edit?.(doc) });
  }
  const copy = slot('ms-slot ms-slot-inline');
  row.appendChild(copy);
  mountButton(copy, { label: 'Copy JSON', variant: 'ghost', size: 'xs', onClick: () => actions.copy(doc) });
  if (actions.remove) {
    const remove = slot('ms-slot ms-slot-inline');
    row.appendChild(remove);
    mountButton(remove, { label: 'Delete', variant: 'destructive', size: 'xs', onClick: () => actions.remove?.(doc) });
  }
  return row;
}

function tableView(docs: Record<string, unknown>[], actions: RowActions | null): HTMLElement {
  const columns = columnsOf(docs);
  const wrap = h('div', 'ms-table-wrap');
  const table = h('table', 'ms-table');
  const head = h('tr');
  for (const column of columns) head.appendChild(h('th', null, column));
  if (actions) head.appendChild(h('th', null, 'Actions'));
  table.appendChild(h('thead')).appendChild(head);
  const body = h('tbody');
  for (const doc of docs) {
    const row = h('tr');
    for (const column of columns) {
      const text = cellText(doc[column]);
      const cell = h('td', column === '_id' ? 'ms-cell ms-cell-id' : 'ms-cell', text);
      cell.title = text;
      row.appendChild(cell);
    }
    if (actions) {
      const cell = h('td', 'ms-cell ms-cell-actions');
      cell.appendChild(actionRow(doc, actions));
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

function jsonView(items: unknown[], actions: RowActions | null): HTMLElement {
  const list = h('div', 'ms-doc-list');
  for (const item of items) {
    const card = h('div', 'ms-doc-card');
    card.appendChild(h('pre', 'ms-json', prettyJson(item)));
    if (actions && isPlainObject(item)) card.appendChild(actionRow(item, actions));
    list.appendChild(card);
  }
  return list;
}

function treeView(items: unknown[], actions: RowActions | null): HTMLElement {
  const list = h('div', 'ms-doc-list');
  for (const item of items) {
    const card = h('div', 'ms-doc-card ms-tree-doc');
    card.appendChild(treeNode(item, null, 0));
    if (actions && isPlainObject(item)) card.appendChild(actionRow(item, actions));
    list.appendChild(card);
  }
  return list;
}

/**
 * Hiển thị danh sách document theo chế độ đã chọn.
 *
 * Args:
 *   container: Nơi đặt kết quả (sẽ bị xoá nội dung cũ).
 *   docs: Các document ở dạng Extended JSON.
 *   mode: Table, JSON hoặc Tree.
 *   actions: Thao tác cho từng dòng, hoặc null để tắt.
 */
export function renderDocs(container: HTMLElement, docs: unknown[], mode: ViewMode, actions: RowActions | null): void {
  container.replaceChildren();
  if (mode === 'table' && docs.every(isPlainObject)) {
    container.appendChild(tableView(docs as Record<string, unknown>[], actions));
    return;
  }
  const view = mode === 'tree' ? treeView(docs, actions) : jsonView(docs, actions);
  container.appendChild(view);
}

/**
 * Hiển thị kết quả bất kỳ (số, object, mảng giá trị đơn) dưới dạng JSON hoặc cây.
 *
 * Args:
 *   container: Nơi đặt kết quả.
 *   result: Kết quả đã serialize.
 *   mode: Chế độ xem; table dùng JSON cho kết quả không phải danh sách document.
 */
export function renderValue(container: HTMLElement, result: unknown, mode: ViewMode): void {
  container.replaceChildren();
  if (Array.isArray(result) && mode !== 'json' && result.every(isPlainObject)) {
    renderDocs(container, result, mode, null);
    return;
  }
  if (mode === 'tree') {
    container.appendChild(h('div', 'ms-doc-card ms-tree-doc')).appendChild(treeNode(result, null, 0));
    return;
  }
  container.appendChild(h('pre', 'ms-json', prettyJson(result)));
}
