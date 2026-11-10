/**
 * Tab Collection: filter, sort, projection, phân trang, xem Table/JSON/Tree, và sub-tab Indexes.
 * Thao tác ghi (thêm, sửa, xoá) chỉ hiện khi connection không ở chế độ Read-only, và luôn xác nhận.
 */
import { mountBanner, mountButton, mountEmpty, mountList, mountSpinner, mountTabs, mountTextField, type ButtonHandle } from '@openchamber/sdk/ui';

import type { FindResponse, IndexesResponse } from '../shared/api.ts';
import { ApiError } from './api.ts';
import type { Ctx } from './context.ts';
import { openDocumentDialog } from './document-dialog.ts';
import { confirmDialog } from './dialogs.ts';
import { append, groupDigits, h, slot } from './dom.ts';
import { idText, prettyJson } from './format.ts';
import { renderDocs, type RowActions, type ViewMode } from './results.ts';
import { subscribe, tree } from './state.ts';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 500;

type Section = 'documents' | 'indexes';

export type CollectionView = {
  element: HTMLElement;
  dispose: () => void;
};

type Handle = { dispose(): void };

/**
 * Dựng tab Collection.
 *
 * Args:
 *   ctx: Context dùng chung.
 *   connectionId: Id connection.
 *   database: Tên database.
 *   collection: Tên collection.
 *
 * Returns:
 *   Phần tử của tab và hàm dọn dẹp.
 */
export function createCollectionView(ctx: Ctx, connectionId: string, database: string, collection: string): CollectionView {
  const element = h('div', 'ms-view ms-collection');
  const handles: Handle[] = [];
  const state = {
    filter: '',
    sort: '',
    projection: '',
    limit: String(PAGE_DEFAULT),
    page: 0,
    view: 'table' as ViewMode,
    section: 'documents' as Section,
    docs: null as unknown[] | null,
    total: null as number | null,
    elapsedMs: 0,
    truncatedBySize: false,
    loading: false,
    error: null as ApiError | null,
    indexes: null as Array<Record<string, unknown>> | null,
    indexError: null as string | null,
  };

  const readOnly = (): boolean => tree.connections.find((item) => item.id === connectionId)?.readOnly ?? true;

  // Đầu tab: tên và các nút ghi.
  const head = h('div', 'ms-view-head');
  const titleBox = h('div', 'ms-view-title');
  titleBox.appendChild(h('h2', 'ms-view-name', `${database}.${collection}`));
  const connName = tree.connections.find((item) => item.id === connectionId)?.name ?? 'connection';
  titleBox.appendChild(h('span', 'ms-muted', connName));
  const readOnlyBadge = h('span', 'ms-badge-ro', 'read-only');
  titleBox.appendChild(readOnlyBadge);
  const insertSlot = slot('ms-slot ms-slot-inline');
  append(head, titleBox, insertSlot);
  element.appendChild(head);

  // Sub-tab: Documents | Indexes.
  const subTabsSlot = slot('ms-slot');
  element.appendChild(subTabsSlot);
  const subTabs = mountTabs(subTabsSlot, {
    items: [{ id: 'documents', label: 'Documents' }, { id: 'indexes', label: 'Indexes' }],
    activeId: state.section,
    onChange: (id) => {
      state.section = id as Section;
      subTabs.update({ activeId: state.section });
      showSection();
      if (state.section === 'indexes') void loadIndexes();
    },
  });
  handles.push(subTabs);

  // Khu vực Documents: toolbar, chế độ xem, phân trang và kết quả.
  const documentsSection = h('div', 'ms-section');
  const toolbar = h('div', 'ms-toolbar');
  const fieldGrid = h('div', 'ms-field-grid');
  toolbar.appendChild(fieldGrid);
  const runSlot = slot('ms-slot ms-slot-inline');
  toolbar.appendChild(runSlot);
  append(documentsSection, toolbar);
  const fieldText = (label: string, key: 'filter' | 'sort' | 'projection' | 'limit', placeholder: string, mono = true): void => {
    const node = slot('ms-slot');
    fieldGrid.appendChild(node);
    handles.push(mountTextField(node, {
      label,
      value: state[key],
      placeholder,
      mono,
      onChange: (value) => { state[key] = value; },
    }));
  };
  fieldText('Filter', 'filter', '{ "status": "active" }');
  fieldText('Sort', 'sort', '{ "createdAt": -1 }');
  fieldText('Projection', 'projection', '{ "name": 1, "_id": 0 }');
  fieldText('Limit', 'limit', String(PAGE_DEFAULT), false);
  fieldGrid.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) void run(true);
  });
  handles.push(mountButton(runSlot, { label: 'Run', onClick: () => void run(true) }));

  const controls = h('div', 'ms-results-head');
  const viewSlot = slot('ms-slot');
  const pager = h('div', 'ms-pager');
  const prevSlot = slot('ms-slot ms-slot-inline');
  const pagerText = h('span', 'ms-pager-text');
  const nextSlot = slot('ms-slot ms-slot-inline');
  append(pager, prevSlot, pagerText, nextSlot);
  append(controls, viewSlot, pager);
  documentsSection.appendChild(controls);

  const viewTabs = mountTabs(viewSlot, {
    items: [{ id: 'table', label: 'Table' }, { id: 'json', label: 'JSON' }, { id: 'tree', label: 'Tree' }],
    activeId: state.view,
    onChange: (id) => {
      state.view = id as ViewMode;
      viewTabs.update({ activeId: state.view });
      renderResults();
    },
  });
  handles.push(viewTabs);
  const prevButton = mountButton(prevSlot, { label: 'Prev', variant: 'outline', size: 'xs', onClick: () => void page(-1) });
  const nextButton = mountButton(nextSlot, { label: 'Next', variant: 'outline', size: 'xs', onClick: () => void page(1) });
  handles.push(prevButton, nextButton);

  const statusLine = h('div', 'ms-status-line ms-muted');
  const resultBox = h('div', 'ms-results');
  append(documentsSection, statusLine, resultBox);
  element.appendChild(documentsSection);

  // Khu vực Indexes.
  const indexSection = h('div', 'ms-section');
  indexSection.hidden = true;
  const indexBox = h('div', 'ms-results');
  indexSection.appendChild(indexBox);
  element.appendChild(indexSection);

  const showSection = (): void => {
    documentsSection.hidden = state.section !== 'documents';
    indexSection.hidden = state.section !== 'indexes';
  };

  const actionsFor = (): RowActions => {
    const actions: RowActions = { copy: (doc) => ctx.copy(prettyJson(doc), 'Document') };
    if (!readOnly()) {
      actions.edit = (doc) => editDocument(doc);
      actions.remove = (doc) => removeDocument(doc);
    }
    return actions;
  };

  const refreshChrome = (): void => {
    const ro = readOnly();
    readOnlyBadge.hidden = !ro;
    insertSlot.hidden = ro;
  };

  const renderResults = (): void => {
    statusLine.textContent = '';
    resultBox.replaceChildren();
    renderPager();
    if (state.loading) {
      const node = slot('ms-slot');
      resultBox.appendChild(node);
      handles.push(mountSpinner(node, { label: 'Đang chạy truy vấn…' }));
      return;
    }
    if (state.error) {
      renderError(state.error);
      return;
    }
    if (state.docs === null) return;
    statusLine.textContent = `${groupDigits(state.docs.length)} document · ${state.elapsedMs} ms${state.truncatedBySize ? ' · đã cắt bớt vì kích thước' : ''}`;
    if (state.docs.length === 0) {
      renderEmpty();
      return;
    }
    renderDocs(resultBox, state.docs, state.view, actionsFor());
  };

  const renderError = (error: ApiError): void => {
    const node = slot('ms-slot ms-slot-banner');
    resultBox.appendChild(node);
    handles.push(mountBanner(node, {
      tone: 'error',
      title: error.position ? 'Lỗi cú pháp' : 'Không chạy được truy vấn',
      body: error.message,
    }));
  };

  const renderEmpty = (): void => {
    const node = slot('ms-slot');
    resultBox.appendChild(node);
    const filtered = state.filter.trim() !== '' || state.sort.trim() !== '';
    const empty = filtered
      ? { title: 'Không có document khớp', body: 'Thử bỏ hoặc nới filter, rồi nhấn Run.' }
      : readOnly()
        ? { title: 'Collection trống', body: 'Connection đang ở chế độ Read-only nên không thêm được document.' }
        : { title: 'Collection trống', body: 'Nhấn Insert để thêm document đầu tiên.' };
    handles.push(mountEmpty(node, empty));
  };

  const renderPager = (): void => {
    const limit = limitValue();
    const from = state.docs && state.docs.length > 0 ? state.page * limit + 1 : 0;
    const to = state.docs ? state.page * limit + state.docs.length : 0;
    const totalText = state.total === null ? 'total unknown' : `${groupDigits(state.total)} total`;
    pagerText.textContent = state.docs ? `${groupDigits(from)}–${groupDigits(to)} · ${totalText}` : '';
    const hasNext = state.total !== null
      ? (state.page + 1) * limit < state.total
      : (state.docs?.length ?? 0) === limit;
    setPagerEnabled(state.page > 0, hasNext);
  };

  const setPagerEnabled = (hasPrev: boolean, hasNext: boolean): void => {
    prevButton.update({ disabled: !hasPrev || state.loading });
    nextButton.update({ disabled: !hasNext || state.loading });
  };

  const limitValue = (): number => {
    const parsed = Number(state.limit);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= PAGE_MAX ? parsed : PAGE_DEFAULT;
  };

  const run = async (resetPage: boolean): Promise<void> => {
    if (resetPage) state.page = 0;
    const parsed = Number(state.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > PAGE_MAX) {
      state.error = new ApiError(`Limit phải là số nguyên từ 1 đến ${PAGE_MAX}`, 'BAD_LIMIT', 400);
      state.docs = null;
      renderResults();
      return;
    }
    state.loading = true;
    state.error = null;
    renderResults();
    try {
      const limit = limitValue();
      const reply = await ctx.api.call<FindResponse>('/collection/find', {
        connectionId,
        database,
        collection,
        filter: state.filter,
        sort: state.sort,
        projection: state.projection,
        skip: state.page * limit,
        limit,
      });
      state.docs = reply.docs;
      state.total = reply.total;
      state.elapsedMs = reply.elapsedMs;
      state.truncatedBySize = reply.truncatedBySize;
    } catch (error) {
      state.error = error instanceof ApiError ? error : new ApiError('Không chạy được truy vấn', 'UNKNOWN', 0);
      state.docs = null;
    } finally {
      state.loading = false;
      renderResults();
    }
  };

  const page = async (delta: number): Promise<void> => {
    state.page = Math.max(0, state.page + delta);
    await run(false);
  };

  const loadIndexes = async (): Promise<void> => {
    indexBox.replaceChildren();
    const node = slot('ms-slot');
    indexBox.appendChild(node);
    handles.push(mountSpinner(node, { label: 'Đang tải index…' }));
    try {
      const reply = await ctx.api.call<IndexesResponse>('/collection/indexes', { connectionId, database, collection });
      state.indexes = reply.indexes;
      state.indexError = null;
    } catch (error) {
      state.indexes = null;
      state.indexError = error instanceof Error ? error.message : 'Không tải được index';
    }
    renderIndexes();
  };

  const renderIndexes = (): void => {
    indexBox.replaceChildren();
    if (state.indexError) {
      const node = slot('ms-slot ms-slot-banner');
      indexBox.appendChild(node);
      handles.push(mountBanner(node, { tone: 'error', title: 'Không tải được index', body: state.indexError }));
      return;
    }
    const indexes = state.indexes ?? [];
    const node = slot('ms-slot');
    indexBox.appendChild(node);
    handles.push(mountList(node, {
      ariaLabel: 'Indexes',
      emptyText: 'Collection này chưa có index.',
      items: indexes.map((index) => ({
        id: String(index.name),
        title: String(index.name),
        subtitle: JSON.stringify(index.key ?? {}),
        badge: index.unique === true ? { label: 'unique', tone: 'info' as const } : undefined,
      })),
      onSelect: () => undefined,
    }));
  };

  const editDocument = (doc: Record<string, unknown>): void => {
    openDocumentDialog({
      title: `Edit document · _id ${idText(doc)}`,
      initial: prettyJson(doc),
      confirmTitle: 'Lưu thay đổi?',
      confirmMessage: `Thay toàn bộ document có _id ${idText(doc)} bằng nội dung mới. Không hoàn tác được.`,
      save: async (text) => {
        await ctx.api.call('/documents/replace', { connectionId, database, collection, id: doc._id, document: text });
      },
      onSaved: () => {
        ctx.toast('success', 'Đã lưu document');
        void run(false);
      },
    });
  };

  const removeDocument = async (doc: Record<string, unknown>): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Xoá document?',
      message: `Xoá document có _id ${idText(doc)}. Không hoàn tác được.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await ctx.api.call('/documents/delete', { connectionId, database, collection, id: doc._id });
      ctx.toast('success', 'Đã xoá document');
      await run(false);
    } catch (error) {
      ctx.toast('error', error instanceof Error ? error.message : 'Không xoá được document');
    }
  };

  const insertButton: ButtonHandle = mountButton(insertSlot, {
    label: 'Insert document',
    variant: 'outline',
    size: 'sm',
    onClick: () => {
      openDocumentDialog({
        title: `Insert document · ${database}.${collection}`,
        initial: '{\n  \n}',
        confirmTitle: 'Thêm document?',
        confirmMessage: `Thêm một document mới vào ${database}.${collection}.`,
        save: async (text) => {
          await ctx.api.call('/documents/insert', { connectionId, database, collection, document: text });
        },
        onSaved: () => {
          ctx.toast('success', 'Đã thêm document');
          void run(true);
        },
      });
    },
  });
  handles.push(insertButton);

  const unsubscribe = subscribe(refreshChrome);
  refreshChrome();
  showSection();
  renderResults();
  void run(true);

  return {
    element,
    dispose: () => {
      unsubscribe();
      for (const handle of handles) handle.dispose();
      element.remove();
    },
  };
}
