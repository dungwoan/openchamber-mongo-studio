/**
 * Khung chính của panel: thanh trên, cây bên trái, và hệ thống tab bên phải.
 */
import { mountButton, mountEmpty, mountTabs } from '@openchamber/sdk/ui';

import type { ConnectionView } from '../shared/api.ts';
import { type Api, type GuestHost } from './api.ts';
import { createCollectionView } from './collection-view.ts';
import { openConnectionDialog } from './connection-dialog.ts';
import { type Ctx, messageOf, type ToastKind } from './context.ts';
import { confirmDialog } from './dialogs.ts';
import { append, h, slot } from './dom.ts';
import { createQueryView } from './query-view.ts';
import { mountSidebar } from './sidebar.ts';
import { forgetConnectionCache, loadConnections, tree } from './state.ts';

/** Giới hạn ký tự của host.writeClipboard. */
const CLIPBOARD_MAX = 32000;

type TabHandle = { id: string; key: string | null; connectionId: string | null; label: string; element: HTMLElement; dispose: () => void };

type StartOptions = {
  host: GuestHost;
  api: Api;
  root: HTMLElement;
};

/**
 * Dựng toàn bộ giao diện panel và tải danh sách connection.
 *
 * Args:
 *   options: Client OpenChamber, API service và phần tử gốc.
 */
export function startWorkspace(options: StartOptions): void {
  const { host, api, root } = options;
  root.replaceChildren();

  const toast = (kind: ToastKind, message: string): void => {
    host.toast({ kind, message }).catch(() => undefined);
  };
  const copy = (text: string, what: string): void => {
    if (text.length > CLIPBOARD_MAX) {
      toast('error', `${what} quá dài để copy (tối đa ${CLIPBOARD_MAX.toLocaleString('en-US')} ký tự). Thu hẹp kết quả rồi thử lại.`);
      return;
    }
    host.writeClipboard(text).then(
      () => toast('success', `Đã copy ${what.toLowerCase()}`),
      () => toast('error', 'Không copy được vào clipboard'),
    );
  };

  // Khung giao diện.
  const app = h('div', 'ms-app');
  app.dataset.tree = 'open';
  const topbar = h('header', 'ms-topbar');
  const treeToggle = h('button', 'ms-tree-toggle', 'Connections');
  treeToggle.type = 'button';
  treeToggle.addEventListener('click', () => {
    app.dataset.tree = app.dataset.tree === 'open' ? 'closed' : 'open';
  });
  const addSlot = slot('ms-slot ms-slot-inline');
  const queryBtnSlot = slot('ms-slot ms-slot-inline');
  append(topbar, treeToggle, h('span', 'ms-brand', 'Mongo Studio'), h('span', 'ms-spacer'), addSlot, queryBtnSlot);

  const body = h('div', 'ms-body');
  const sidebar = h('aside', 'ms-sidebar');
  sidebar.appendChild(h('div', 'ms-section-head', 'Connections'));
  const sidebarBody = h('div', 'ms-sidebar-body');
  sidebar.appendChild(sidebarBody);

  const main = h('main', 'ms-main');
  const tabbar = h('div', 'ms-tabbar');
  const tabsSlot = slot('ms-slot ms-tabs');
  const closeSlot = slot('ms-slot ms-slot-inline');
  const tabActions = h('div', 'ms-tabbar-actions');
  append(tabActions, closeSlot);
  append(tabbar, tabsSlot, tabActions);
  const tabBody = h('div', 'ms-tabbody');
  const emptyMain = slot('ms-slot ms-main-empty');
  append(main, tabbar, tabBody, emptyMain);
  append(body, sidebar, main);
  append(app, topbar, body);
  root.appendChild(app);

  // Trạng thái tab.
  const tabs: TabHandle[] = [];
  let activeId: string | null = null;
  let counter = 0;

  const tabsHandle = mountTabs(tabsSlot, {
    items: [],
    activeId: '',
    onChange: (id) => activate(id),
  });
  const closeHandle = mountButton(closeSlot, {
    label: 'Close tab',
    variant: 'ghost',
    size: 'xs',
    disabled: true,
    onClick: () => {
      if (activeId) closeTab(activeId);
    },
  });
  mountEmpty(emptyMain, {
    title: 'Chưa có tab nào',
    body: 'Chọn một collection trong cây bên trái để xem document, hoặc mở Query để viết lệnh kiểu mongo shell.',
    action: { label: 'New query', onClick: () => openQuery() },
  });

  /** Nhãn tab; hai collection cùng tên ở hai connection được thêm tên connection để phân biệt. */
  function labelsOf(): Array<{ id: string; label: string }> {
    const counts = new Map<string, number>();
    for (const tab of tabs) counts.set(tab.label, (counts.get(tab.label) ?? 0) + 1);
    return tabs.map((tab) => {
      const duplicated = (counts.get(tab.label) ?? 0) > 1 && tab.key !== null;
      const name = duplicated ? `${tab.label} · ${connectionNameOf(tab.connectionId)}` : tab.label;
      return { id: tab.id, label: name };
    });
  }

  function connectionNameOf(connectionId: string | null): string {
    return tree.connections.find((item) => item.id === connectionId)?.name ?? '(đã xoá)';
  }

  function showActive(): void {
    for (const tab of tabs) tab.element.hidden = tab.id !== activeId;
    const empty = tabs.length === 0;
    emptyMain.hidden = !empty;
    tabbar.hidden = empty;
    tabBody.hidden = empty;
    tabsHandle.update({ items: labelsOf(), activeId: activeId ?? '' });
    closeHandle.update({ disabled: activeId === null });
  }

  function activate(id: string): void {
    activeId = id;
    showActive();
  }

  function closeTab(id: string): void {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const [tab] = tabs.splice(index, 1);
    tab?.dispose();
    if (activeId === id) activeId = tabs[Math.max(0, index - 1)]?.id ?? null;
    showActive();
  }

  function addTab(tab: Omit<TabHandle, 'id'>): void {
    counter += 1;
    const full: TabHandle = { ...tab, id: `tab-${counter}` };
    tabBody.appendChild(full.element);
    tabs.push(full);
    activate(full.id);
  }

  function openCollection(connectionId: string, database: string, collection: string): void {
    const key = `${connectionId}/${database}/${collection}`;
    const existing = tabs.find((tab) => tab.key === key);
    if (existing) {
      activate(existing.id);
      return;
    }
    const view = createCollectionView(ctx, connectionId, database, collection);
    addTab({ key, connectionId, label: collection, element: view.element, dispose: view.dispose });
  }

  function openQuery(seed?: { connectionId: string | null; database: string | null; text: string }): void {
    const view = createQueryView(ctx, seed ?? null);
    const number = tabs.filter((tab) => tab.key === null).length + 1;
    addTab({ key: null, connectionId: seed?.connectionId ?? null, label: `Query ${number}`, element: view.element, dispose: view.dispose });
  }

  function closeTabsOf(connectionId: string): void {
    for (const tab of tabs.filter((item) => item.key !== null && item.connectionId === connectionId)) {
      closeTab(tab.id);
    }
  }

  // Thao tác connection.
  function addConnection(): void {
    openConnectionDialog(ctx, null, (saved) => {
      void loadConnections(api).then(() => toast('success', `Đã thêm connection "${saved.name}"`));
    });
  }

  function editConnection(connection: ConnectionView): void {
    openConnectionDialog(ctx, connection, () => {
      forgetConnectionCache(connection.id);
      void loadConnections(api);
    });
  }

  async function disconnect(connection: ConnectionView): Promise<void> {
    try {
      await api.call('/connections/disconnect', { id: connection.id });
      forgetConnectionCache(connection.id);
      tree.expandedConnections.delete(connection.id);
      await loadConnections(api);
    } catch (error) {
      toast('error', messageOf(error));
    }
  }

  async function deleteConnection(connection: ConnectionView): Promise<void> {
    const ok = await confirmDialog({
      title: 'Xoá connection?',
      message: `Xoá "${connection.name}" khỏi Mongo Studio. URI đã lưu trên máy này cũng bị xoá. Không hoàn tác được.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.call('/connections/delete', { id: connection.id });
      closeTabsOf(connection.id);
      forgetConnectionCache(connection.id);
      await loadConnections(api);
      toast('success', `Đã xoá connection "${connection.name}"`);
    } catch (error) {
      toast('error', messageOf(error));
    }
  }

  const ctx: Ctx = {
    host,
    api,
    toast,
    copy,
    openCollection,
    openQuery,
    addConnection,
    editConnection,
    disconnect: (connection) => void disconnect(connection),
    deleteConnection: (connection) => void deleteConnection(connection),
    closeTabsOf,
  };

  mountButton(addSlot, { label: 'Add connection', size: 'sm', onClick: addConnection });
  mountButton(queryBtnSlot, { label: '+ Query', variant: 'outline', size: 'sm', onClick: () => openQuery() });
  treeToggle.setAttribute('aria-label', 'Hiện hoặc ẩn danh sách connection');

  mountSidebar(sidebarBody, ctx);
  showActive();
  void loadConnections(api);
}
