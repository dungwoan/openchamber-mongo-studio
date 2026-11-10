/**
 * Cây bên trái: Connection → Database → Collection. Database và collection tải khi được mở.
 */
import { mountBanner, mountEmpty, mountMenu } from '@openchamber/sdk/ui';

import type { ConnectionView, CollectionInfo, DatabaseInfo } from '../shared/api.ts';
import type { Ctx } from './context.ts';
import { groupDigits, h, slot } from './dom.ts';
import { dbKey, emit, loadCollections, loadConnections, loadDatabases, subscribe, tree } from './state.ts';

type Handle = { dispose(): void };

/** Dọn các control đã mount trước khi dựng lại cây. */
function disposeAll(handles: Handle[]): void {
  for (const handle of handles.splice(0)) handle.dispose();
}

function menuSlot(handles: Handle[], parent: HTMLElement, label: string, items: Parameters<typeof mountMenu>[1]['items'], onSelect: (id: string) => void): void {
  const node = slot('ms-slot ms-slot-inline');
  parent.appendChild(node);
  handles.push(mountMenu(node, { label, variant: 'ghost', size: 'xs', items, onSelect }));
}

function chevron(open: boolean, onClick: () => void): HTMLButtonElement {
  const button = h('button', 'ms-chevron', open ? '▾' : '▸');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(open));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * Mount cây vào container và tự cập nhật khi state thay đổi.
 *
 * Args:
 *   container: Phần tử cha của cây.
 *   ctx: Context dùng chung.
 *
 * Returns:
 *   Hàm huỷ đăng ký và dọn DOM.
 */
export function mountSidebar(container: HTMLElement, ctx: Ctx): () => void {
  const handles: Handle[] = [];
  const list = h('div', 'ms-tree');
  container.appendChild(list);

  const toggleConnection = (connection: ConnectionView): void => {
    if (tree.expandedConnections.has(connection.id)) {
      tree.expandedConnections.delete(connection.id);
      emit();
      return;
    }
    tree.expandedConnections.add(connection.id);
    emit();
    if (!tree.databases.has(connection.id)) {
      loadDatabases(ctx.api, connection.id).catch(() => undefined);
    }
  };

  const toggleDatabase = (connection: ConnectionView, database: string): void => {
    const key = dbKey(connection.id, database);
    if (tree.expandedDatabases.has(key)) {
      tree.expandedDatabases.delete(key);
      emit();
      return;
    }
    tree.expandedDatabases.add(key);
    emit();
    if (!tree.collections.has(key)) loadCollections(ctx.api, connection.id, database).catch(() => undefined);
  };

  const renderCollections = (connection: ConnectionView, database: string, parent: HTMLElement): void => {
    const key = dbKey(connection.id, database);
    if (tree.loading.has(key)) parent.appendChild(h('div', 'ms-tree-note ms-muted', 'Đang tải collection…'));
    const error = tree.errors.get(key);
    if (error) parent.appendChild(errorNote(error));
    const collections: CollectionInfo[] = tree.collections.get(key) ?? [];
    for (const collection of collections) {
      const row = h('div', 'ms-tree-line ms-tree-leaf');
      const name = h('button', 'ms-tree-name', collection.name);
      name.type = 'button';
      name.addEventListener('click', () => ctx.openCollection(connection.id, database, collection.name));
      row.appendChild(name);
      row.appendChild(h('span', 'ms-tree-meta', collection.type === 'view' ? 'view' : formatCount(collection.count)));
      menuSlot(handles, row, '⋯', [{ id: 'query', label: 'New query' }], () => {
        ctx.openQuery({
          connectionId: connection.id,
          database,
          text: `db.${collection.name}.find({}).limit(50)`,
        });
      });
      parent.appendChild(row);
    }
  };

  const renderDatabases = (connection: ConnectionView, parent: HTMLElement): void => {
    if (tree.loading.has(connection.id)) parent.appendChild(h('div', 'ms-tree-note ms-muted', 'Đang tải database…'));
    const error = tree.errors.get(connection.id);
    if (error) parent.appendChild(errorNote(error));
    const databases: DatabaseInfo[] = tree.databases.get(connection.id) ?? [];
    for (const database of databases) {
      const key = dbKey(connection.id, database.name);
      const open = tree.expandedDatabases.has(key);
      const row = h('div', 'ms-tree-line ms-tree-db');
      row.appendChild(chevron(open, () => toggleDatabase(connection, database.name)));
      const name = h('button', 'ms-tree-name', database.name);
      name.type = 'button';
      name.addEventListener('click', () => toggleDatabase(connection, database.name));
      row.appendChild(name);
      if (database.sizeOnDisk !== null) row.appendChild(h('span', 'ms-tree-meta', formatBytes(database.sizeOnDisk)));
      parent.appendChild(row);
      if (open) {
        const children = h('div', 'ms-tree-children');
        renderCollections(connection, database.name, children);
        parent.appendChild(children);
      }
    }
  };

  const renderConnection = (connection: ConnectionView): HTMLElement => {
    const wrap = h('div', 'ms-tree-item');
    const row = h('div', 'ms-tree-line');
    const open = tree.expandedConnections.has(connection.id);
    row.appendChild(chevron(open, () => toggleConnection(connection)));
    row.appendChild(h('span', connection.connected ? 'ms-dot ms-dot-on' : 'ms-dot', null));
    const name = h('button', 'ms-tree-name ms-tree-strong', connection.name);
    name.type = 'button';
    name.title = connection.hosts;
    name.addEventListener('click', () => toggleConnection(connection));
    row.appendChild(name);
    if (connection.readOnly) row.appendChild(h('span', 'ms-badge-ro', 'read-only'));
    menuSlot(handles, row, '⋯', [
      { id: 'edit', label: 'Edit' },
      { id: 'disconnect', label: 'Disconnect', disabled: !connection.connected },
      { id: 'sep', separator: true },
      { id: 'delete', label: 'Delete', destructive: true },
    ], (id) => {
      if (id === 'edit') ctx.editConnection(connection);
      if (id === 'disconnect') ctx.disconnect(connection);
      if (id === 'delete') ctx.deleteConnection(connection);
    });
    wrap.appendChild(row);
    if (open) {
      const children = h('div', 'ms-tree-children');
      renderDatabases(connection, children);
      wrap.appendChild(children);
    }
    return wrap;
  };

  const render = (): void => {
    disposeAll(handles);
    list.replaceChildren();
    if (tree.connectionsError) {
      list.appendChild(bannerSlot(handles, 'error', 'Không tải được danh sách connection', tree.connectionsError, 'Thử lại', () => {
        void loadConnections(ctx.api);
      }));
      return;
    }
    if (!tree.loadingConnections && tree.connections.length === 0) {
      const node = slot('ms-slot');
      list.appendChild(node);
      handles.push(mountEmpty(node, {
        title: 'Chưa có connection',
        body: 'Nhấn Add connection và dán URI MongoDB của bạn. URI được lưu trên máy này, không gửi đi đâu khác.',
        action: { label: 'Add connection', onClick: ctx.addConnection },
      }));
      return;
    }
    for (const connection of tree.connections) list.appendChild(renderConnection(connection));
  };

  const unsubscribe = subscribe(render);
  render();
  return () => {
    unsubscribe();
    disposeAll(handles);
    list.remove();
  };
}

function bannerSlot(handles: Handle[], tone: 'error' | 'info', title: string, body: string, actionLabel: string, onAction: () => void): HTMLElement {
  const node = slot('ms-slot ms-slot-banner');
  handles.push(mountBanner(node, { tone, title, body, action: { label: actionLabel, onClick: onAction } }));
  return node;
}

function errorNote(message: string): HTMLElement {
  return h('div', 'ms-tree-error', message);
}

function formatCount(count: number | null): string {
  return count === null ? '' : groupDigits(count);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

