/**
 * Tab Query: editor kiểu mongo shell, chạy lệnh tại con trỏ, kết quả và lịch sử lưu trên service.
 */
import { mountBanner, mountButton, mountList, mountSelect, mountTabs, mountTextField, type ButtonHandle } from '@openchamber/sdk/ui';

import type { DatabaseInfo, HistoryEntry, HistoryResponse, QueryResponse } from '../shared/api.ts';
import { ApiError } from './api.ts';
import type { Ctx } from './context.ts';
import { confirmDialog } from './dialogs.ts';
import { groupDigits, h, relativeTime, slot } from './dom.ts';
import { prettyJson } from './format.ts';
import { renderValue, type ViewMode } from './results.ts';
import { loadDatabases, subscribe, tree } from './state.ts';

export type QuerySeed = { connectionId: string | null; database: string | null; text: string };

export type QueryView = {
  element: HTMLElement;
  title: () => string;
  dispose: () => void;
};

const HISTORY_SHOWN = 20;

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim() !== '') ?? '';
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

/**
 * Dựng tab Query.
 *
 * Args:
 *   ctx: Context dùng chung.
 *   seed: Connection, database và câu lệnh mở sẵn (có thể null).
 *
 * Returns:
 *   Phần tử tab, tiêu đề và hàm dọn dẹp.
 */
export function createQueryView(ctx: Ctx, seed: QuerySeed | null): QueryView {
  const element = h('div', 'ms-view ms-query');
  const handles: Array<{ dispose(): void }> = [];
  const state = {
    connectionId: seed?.connectionId ?? null,
    database: seed?.database ?? null,
    text: seed?.text ?? '',
    view: 'table' as ViewMode,
    databases: [] as DatabaseInfo[],
    result: null as QueryResponse | null,
    error: null as ApiError | null,
    running: false,
    history: [] as HistoryEntry[],
  };

  const toolbar = h('div', 'ms-query-toolbar');
  const connSlot = slot('ms-slot');
  const dbSlot = slot('ms-slot');
  const runSlot = slot('ms-slot ms-slot-inline');
  toolbar.appendChild(connSlot);
  toolbar.appendChild(dbSlot);
  toolbar.appendChild(runSlot);
  element.appendChild(toolbar);

  const editorSlot = slot('ms-slot ms-editor');
  element.appendChild(editorSlot);
  element.appendChild(h('div', 'ms-hint ms-muted', 'Ctrl/⌘ + Enter chạy lệnh tại con trỏ. Nhiều lệnh cách nhau bằng ";". find và aggregate tối đa 500 dòng.'));
  const bannerSlot = slot('ms-slot');
  element.appendChild(bannerSlot);

  const resultHead = h('div', 'ms-results-head');
  const statusLine = h('div', 'ms-status-line ms-muted');
  const viewSlot = slot('ms-slot');
  const copySlot = slot('ms-slot ms-slot-inline');
  resultHead.appendChild(viewSlot);
  resultHead.appendChild(copySlot);
  const resultBox = h('div', 'ms-results');
  element.appendChild(resultHead);
  element.appendChild(statusLine);
  element.appendChild(resultBox);

  const historyHead = h('div', 'ms-section-head', 'Lịch sử gần đây');
  const historySlot = slot('ms-slot');
  element.appendChild(historyHead);
  element.appendChild(historySlot);

  const connName = (id: string | null): string => (id ? tree.connections.find((item) => item.id === id)?.name ?? '(đã xoá)' : '');

  const connSelect = mountSelect(connSlot, {
    label: 'Connection',
    value: state.connectionId,
    placeholder: 'Chọn connection',
    options: tree.connections.map((item) => ({ id: item.id, label: item.name, hint: item.hosts })),
    onChange: (id) => void selectConnection(id),
  });
  handles.push(connSelect);

  const dbSelect = mountSelect(dbSlot, {
    label: 'Database',
    value: state.database,
    placeholder: state.connectionId ? 'Chọn database' : 'Chọn connection trước',
    options: state.databases.map((item) => ({ id: item.name, label: item.name })),
    disabled: !state.connectionId,
    onChange: (name) => {
      state.database = name;
      dbSelect.update({ value: name });
    },
  });
  handles.push(dbSelect);

  const runButton: ButtonHandle = mountButton(runSlot, { label: 'Run ▶', onClick: () => void run(false) });
  handles.push(runButton);

  const editor = mountTextField(editorSlot, {
    label: 'Query',
    value: state.text,
    multiline: true,
    rows: 9,
    mono: true,
    placeholder: 'db.users.find({ status: "active" }).sort({ createdAt: -1 }).limit(20)',
    onChange: (value) => { state.text = value; },
  });
  handles.push(editor);

  const textarea = (): HTMLTextAreaElement | null => editorSlot.querySelector('textarea');
  editorSlot.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void run(false);
    }
  });

  const viewTabs = mountTabs(viewSlot, {
    items: [{ id: 'table', label: 'Table' }, { id: 'json', label: 'JSON' }, { id: 'tree', label: 'Tree' }],
    activeId: state.view,
    onChange: (id) => {
      state.view = id as ViewMode;
      viewTabs.update({ activeId: state.view });
      renderResult();
    },
  });
  handles.push(viewTabs);
  handles.push(mountButton(copySlot, {
    label: 'Copy',
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      if (state.result) ctx.copy(prettyJson(state.result.result), 'Kết quả');
    },
  }));

  const historyList = mountList(historySlot, {
    ariaLabel: 'Lịch sử query',
    emptyText: 'Chưa có lịch sử. Lệnh chạy xong sẽ được lưu ở đây.',
    items: [],
    onSelect: (id) => loadHistory(id),
  });
  handles.push(historyList);

  function renderBanner(error: ApiError | null): void {
    bannerSlot.replaceChildren();
    if (!error) return;
    const node = slot('ms-slot ms-slot-banner');
    bannerSlot.appendChild(node);
    // Thông báo của lỗi cú pháp đã có dòng và cột; tiêu đề chỉ nêu loại lỗi.
    const title = error.position ? 'Lỗi cú pháp' : 'Không chạy được lệnh';
    handles.push(mountBanner(node, { tone: 'error', title, body: error.message }));
  }

  function renderResult(): void {
    resultBox.replaceChildren();
    statusLine.textContent = '';
    if (state.running) {
      statusLine.textContent = 'Đang chạy…';
      return;
    }
    const result = state.result;
    if (!result) return;
    const count = result.count === null ? '' : ` · ${groupDigits(result.count)} dòng`;
    const cut = result.truncated ? ' · đã cắt ở 500 dòng' : '';
    const write = result.isWrite ? ' · lệnh ghi' : '';
    statusLine.textContent = `${result.kind}${count} · ${result.elapsedMs} ms · lệnh ${result.statement.index + 1}/${result.statement.total}${write}${cut}`;
    renderValue(resultBox, result.result, state.view);
  }

  /**
   * Chọn connection và nạp danh sách database của nó.
   *
   * Args:
   *   id: Connection cần chọn, hoặc null để bỏ chọn.
   *   keepDatabase: Database muốn giữ lại sau khi nạp (dùng khi mở tab từ menu của collection).
   */
  async function selectConnection(id: string | null, keepDatabase: string | null = null): Promise<void> {
    state.connectionId = id;
    state.database = keepDatabase;
    state.databases = [];
    connSelect.update({ value: id });
    dbSelect.update({ value: null, options: [], disabled: !id, placeholder: id ? 'Đang tải database…' : 'Chọn connection trước' });
    if (!id) return;
    try {
      state.databases = await loadDatabases(ctx.api, id);
      dbSelect.update({
        options: state.databases.map((item) => ({ id: item.name, label: item.name })),
        value: state.database,
        placeholder: 'Chọn database',
      });
    } catch (error) {
      renderBanner(error instanceof ApiError ? error : new ApiError('Không tải được database', 'UNKNOWN', 0));
    }
  }

  async function loadHistoryList(): Promise<void> {
    try {
      const reply = await ctx.api.call<HistoryResponse>('/query/history');
      state.history = reply.entries.slice(0, HISTORY_SHOWN);
    } catch {
      state.history = [];
    }
    historyList.update({
      items: state.history.map((entry, index) => ({
        id: String(index),
        title: firstLine(entry.text),
        subtitle: `${entry.database} · ${connName(entry.connectionId)} · ${relativeTime(entry.at)}`,
      })),
    });
  }

  function loadHistory(id: string): void {
    const entry = state.history[Number(id)];
    if (!entry) return;
    state.text = entry.text;
    editor.update({ value: entry.text });
    void selectConnection(tree.connections.some((item) => item.id === entry.connectionId) ? entry.connectionId : null)
      .then(() => {
        state.database = entry.database;
        dbSelect.update({ value: entry.database });
      });
  }

  async function run(confirmed: boolean): Promise<void> {
    if (state.running) return;
    if (!state.connectionId || !state.database) {
      renderBanner(new ApiError('Chọn connection và database trước khi chạy.', 'NO_TARGET', 400));
      return;
    }
    state.running = true;
    state.error = null;
    renderBanner(null);
    runButton.update({ loading: true, disabled: true });
    renderResult();
    try {
      const cursor = textarea()?.selectionEnd ?? null;
      state.result = await ctx.api.call<QueryResponse>('/query/run', {
        connectionId: state.connectionId,
        database: state.database,
        text: state.text,
        cursor,
        confirmWrite: confirmed,
      });
      void loadHistoryList();
    } catch (error) {
      state.result = null;
      if (error instanceof ApiError && error.code === 'CONFIRM_REQUIRED') {
        state.running = false;
        runButton.update({ loading: false, disabled: false });
        const ok = await confirmDialog({
          title: 'Chạy lệnh ghi?',
          message: `${error.message}\nDatabase: ${state.database} · Connection: ${connName(state.connectionId)}.`,
          confirmLabel: 'Run write',
          destructive: true,
        });
        if (ok) await run(true);
        return;
      }
      state.error = error instanceof ApiError ? error : new ApiError('Không chạy được lệnh', 'UNKNOWN', 0);
      renderBanner(state.error);
    } finally {
      state.running = false;
      runButton.update({ loading: false, disabled: false });
      renderResult();
    }
  }

  const unsubscribe = subscribe(() => {
    connSelect.update({ options: tree.connections.map((item) => ({ id: item.id, label: item.name, hint: item.hosts })) });
  });
  if (state.connectionId) void selectConnection(state.connectionId, state.database);
  void loadHistoryList();
  renderResult();

  return {
    element,
    title: () => (state.text.trim() ? firstLine(state.text) : 'Query'),
    dispose: () => {
      unsubscribe();
      for (const handle of handles) handle.dispose();
      element.remove();
    },
  };
}
