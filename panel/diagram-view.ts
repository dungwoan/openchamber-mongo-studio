/**
 * Tab Sơ đồ: vẽ các collection và quan hệ bằng SVG tự dựng. Mọi nội dung đi qua textContent (không innerHTML).
 * Quá 80 bảng thì chỉ vẽ khi có tìm kiếm hoặc chọn bảng trung tâm (N bước). Cạnh suy đoán tắt mặc định.
 */
import { mountBanner, mountButton, mountEmpty, mountSearchField, mountSelect, mountSwitch } from '@openchamber/sdk/ui';

import type { DiagramGetResponse, DiagramScanResponse, SchemaCollection, SchemaReport, SchemaRelation } from '../shared/api.ts';
import { groupShards, layout, neighborhood, searchNames, type Edge, type Point } from './diagram-layout.ts';
import type { Ctx } from './context.ts';
import { messageOf } from './context.ts';
import { confirmDialog } from './dialogs.ts';
import { append, h, slot } from './dom.ts';

const MAX_VISIBLE = 80;
const CARD_WIDTH = 230;
const HEADER = 28;
const ROW = 18;
const MAX_FIELDS = 12;
const SVG_NS = 'http://www.w3.org/2000/svg';

type Handle = { dispose(): void };
type Card = { id: string; label: string; width: number; height: number; fields: SchemaCollection['fields']; more: number; inferred: boolean };

/** Lời nhắc gửi cho agent: ghi đúng đường dẫn và đúng schema v1; không yêu cầu đọc dữ liệu thật. */
export function agentPrompt(): string {
  const skeleton = '{"version":1,"generatedAt":"<ISO 8601>","source":{"kind":"agent","detectors":[]},"truncated":false,"warnings":[],'
    + '"collections":[{"name":"<tên collection>","model":"<model hoặc null>","file":"<đường dẫn tương đối hoặc null>","orm":"<ORM>",'
    + '"confidence":"declared|inferred","origin":"agent","fields":[{"name":"<tên>","type":"<kiểu>","required":false,"pk":false,"array":false,"inferred":false,"children":[]}],'
    + '"indexes":[{"name":"<tên>","keys":["<field>"],"unique":false,"ttl":false}]}],'
    + '"relations":[{"from":"<collection>","to":"<collection>","field":"<field hoặc null>","kind":"belongsTo|hasMany|hasOne|belongsToMany|reference","confidence":"declared|inferred"}]}';
  return [
    'Hãy đọc mã nguồn của dự án này và ghi mô tả các collection MongoDB vào file .openchamber/mongo-studio/schema-report.json (đường dẫn tương đối trong dự án).',
    'Yêu cầu:',
    `- Chỉ ghi JSON đúng schema v1 sau đây: ${skeleton}`,
    '- Không ghi URI, mật khẩu, token hay giá trị dữ liệu thật. Không đọc dữ liệu trong database.',
    '- Tối đa 300 collection, 100 field mỗi collection, 1000 quan hệ. Đường dẫn file phải tương đối, không có "..".',
    '- Chỉ đưa vào những gì có trong mã nguồn; dùng confidence "inferred" khi chỉ suy đoán.',
    'Sau khi ghi xong, báo lại số collection và số quan hệ đã ghi.',
  ].join('\n');
}

function svgEl(tag: string, attrs: Record<string, string | number>, className?: string): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function cardsOf(
  groups: ReturnType<typeof groupShards>,
  byName: Map<string, SchemaCollection>,
): Card[] {
  return groups.map((group) => {
    const first = byName.get(group.members[0] ?? '');
    const fields = first?.fields ?? [];
    const shown = fields.slice(0, MAX_FIELDS);
    const more = fields.length - shown.length;
    const rows = Math.max(shown.length, 1) + (more > 0 ? 1 : 0);
    return {
      id: group.id,
      label: group.label,
      width: CARD_WIDTH,
      height: HEADER + rows * ROW + 10,
      fields: shown,
      more,
      inferred: first?.confidence === 'inferred',
    };
  });
}

/**
 * Tạo tab Sơ đồ cho một thư mục dự án.
 *
 * Args:
 *   ctx: Context dùng chung (API, host, thông báo).
 *   directory: Thư mục dự án.
 *
 * Returns:
 *   Phần tử gốc và hàm huỷ.
 */
export function createDiagramView(ctx: Ctx, directory: string): { element: HTMLElement; dispose(): void } {
  const root = h('div', 'ms-diagram');
  const toolbar = h('div', 'ms-diagram-toolbar');
  const rowA = h('div', 'ms-diagram-row');
  const rowB = h('div', 'ms-diagram-row');
  const info = h('div', 'ms-diagram-info', null);
  const notes = h('div', 'ms-diagram-info ms-muted', null);
  const bannerSlot = slot('ms-slot ms-slot-banner');
  bannerSlot.hidden = true;
  const canvas = h('div', 'ms-diagram-canvas');
  append(toolbar, rowA, rowB, info, notes);
  append(root, toolbar, bannerSlot, canvas);

  const handles: Handle[] = [];
  const canvasHandles: Handle[] = [];
  let bannerHandle: Handle | null = null;
  let report: SchemaReport | null = null;
  let hasAgent = false;
  let loading = true;
  let writeEnabled = false;
  let showInferred = false;
  let query = '';
  let center: string | null = null;
  let hops = 1;
  let fullscreen = false;
  let gitignore: DiagramScanResponse['gitignore'] | null = null;
  let disposed = false;
  let loadSeq = 0;
  let viewKey = '';
  let view = { x: 0, y: 0, w: 1000, h: 600 };

  const toolbarSlot = (parent: HTMLElement): HTMLDivElement => {
    const node = slot('ms-slot ms-slot-inline');
    parent.appendChild(node);
    return node;
  };

  const scanButton = mountButton(toolbarSlot(rowA), { label: 'Quét lại', variant: 'outline', size: 'sm', onClick: () => void scan() });
  const writeSwitch = mountSwitch(toolbarSlot(rowA), {
    label: 'Ghi báo cáo vào dự án',
    description: 'Lưu .openchamber/mongo-studio/schema-scan.json',
    checked: false,
    onChange: (checked: boolean) => { writeEnabled = checked; },
  });
  const inferredSwitch = mountSwitch(toolbarSlot(rowA), {
    label: 'Cạnh suy đoán',
    description: 'Quan hệ suy ra từ tên field',
    checked: false,
    onChange: (checked: boolean) => { showInferred = checked; render(); },
  });
  const fullButton = mountButton(toolbarSlot(rowA), { label: 'Toàn màn hình', variant: 'ghost', size: 'sm', onClick: () => toggleFullscreen() });
  const agentSlot = toolbarSlot(rowA);
  agentSlot.hidden = true;
  const agentButton = mountButton(agentSlot, { label: 'Nhờ agent bổ sung', variant: 'outline', size: 'sm', onClick: () => void askAgent() });
  const search = mountSearchField(toolbarSlot(rowB), {
    value: '',
    placeholder: 'Tìm bảng…',
    onChange: (value: string) => { query = value; render(); },
  });
  const focus = mountSelect(toolbarSlot(rowB), {
    value: '',
    options: [],
    placeholder: 'Bảng trung tâm',
    searchable: true,
    onChange: (value: string) => { center = value === '' ? null : value; render(); },
  });
  const hopsSelect = mountSelect(toolbarSlot(rowB), {
    value: '1',
    options: [{ id: '1', label: '1 bước' }, { id: '2', label: '2 bước' }, { id: '3', label: '3 bước' }],
    onChange: (value: string) => { hops = Number(value) || 1; render(); },
  });
  const clear = mountButton(toolbarSlot(rowB), {
    label: 'Xoá lọc',
    variant: 'ghost',
    size: 'sm',
    onClick: () => {
      query = '';
      center = null;
      search.update({ value: '' });
      focus.update({ value: '' });
      render();
    },
  });
  handles.push(scanButton, writeSwitch, inferredSwitch, fullButton, agentButton, search, focus, hopsSelect, clear);

  function toggleFullscreen(): void {
    fullscreen = !fullscreen;
    root.classList.toggle('ms-diagram-fullscreen', fullscreen);
    fullButton.update({ label: fullscreen ? 'Thu nhỏ' : 'Toàn màn hình' });
    viewKey = '';
    render();
  }

  function showBanner(tone: 'error' | 'info', title: string, body?: string): void {
    bannerHandle?.dispose();
    bannerSlot.replaceChildren();
    bannerSlot.hidden = false;
    bannerHandle = mountBanner(bannerSlot, { tone, title, body });
  }

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    try {
      const reply = await ctx.api.call<DiagramGetResponse>('/diagram/get', { directory });
      if (disposed || seq !== loadSeq) return;
      report = reply.report;
      hasAgent = reply.hasAgentReport;
      bannerHandle?.dispose();
      bannerHandle = null;
      bannerSlot.replaceChildren();
      bannerSlot.hidden = true;
    } catch (error) {
      if (!disposed && seq === loadSeq) showBanner('error', 'Không tải được sơ đồ', messageOf(error));
    } finally {
      if (!disposed && seq === loadSeq) {
        loading = false;
        render();
      }
    }
  }

  async function scan(): Promise<void> {
    try {
      const reply = await ctx.api.call<DiagramScanResponse>('/diagram/scan', { directory, write: writeEnabled });
      gitignore = reply.gitignore;
      ctx.toast('success', reply.written ? `Đã ghi ${reply.written}` : 'Đã quét lại sơ đồ');
      await load();
    } catch (error) {
      ctx.toast('error', messageOf(error));
    }
  }

  async function askAgent(): Promise<void> {
    const ok = await confirmDialog({
      title: 'Nhờ agent bổ sung sơ đồ?',
      message: 'Lời nhắc sẽ THAY nội dung ô nhập hiện tại trong chat (không gửi). Bạn có thể soạn lại trước khi gửi.',
      confirmLabel: 'Thay ô nhập',
    });
    if (!ok) return;
    try {
      await ctx.host.prompt({ text: agentPrompt(), send: false });
      ctx.toast('success', 'Đã đặt lời nhắc vào ô nhập. Gửi khi bạn sẵn sàng.');
    } catch (error) {
      ctx.toast('error', messageOf(error));
    }
  }

  function setInfo(): void {
    if (report === null) {
      info.textContent = loading ? 'Đang tải sơ đồ…' : '';
      notes.textContent = '';
      return;
    }
    const detectors = report.source.detectors.join(', ') || 'không có';
    info.textContent = `${report.collections.length} bảng · ${report.relations.length} quan hệ · nguồn: ${detectors}`
      + `${report.truncated ? ' · đã cắt bớt' : ''}${hasAgent ? ' · có bổ sung của agent' : ''}`;
    const lines: string[] = [];
    if (gitignore === 'missing') lines.push('Gợi ý: thêm dòng ".openchamber/" vào .gitignore của dự án (Mongo Studio không tự sửa file này).');
    if (gitignore === 'absent') lines.push('Dự án chưa có .gitignore; nếu dùng git, nên thêm ".openchamber/".');
    lines.push(...report.warnings.slice(0, 3));
    notes.textContent = lines.join(' ');
  }

  /** Khung nhìn 1:1 (kích thước thật của canvas) neo ở góc trên trái của sơ đồ; kéo hoặc cuộn để xem phần còn lại. */
  function fitView(positions: Map<string, Point>, cards: Card[]): void {
    const minX = Math.min(...cards.map((card) => positions.get(card.id)?.x ?? 0));
    const minY = Math.min(...cards.map((card) => positions.get(card.id)?.y ?? 0));
    view = { x: minX - 20, y: minY - 20, w: canvas.clientWidth || 700, h: canvas.clientHeight || 480 };
  }

  function drawEdges(svg: SVGElement, relations: SchemaRelation[], positions: Map<string, Point>, cards: Map<string, Card>, groupOf: Map<string, string>): void {
    for (const relation of relations) {
      const fromId = groupOf.get(relation.from);
      const toId = groupOf.get(relation.to);
      if (!fromId || !toId || fromId === toId) continue;
      const a = positions.get(fromId);
      const b = positions.get(toId);
      const ca = cards.get(fromId);
      const cb = cards.get(toId);
      if (!a || !b || !ca || !cb) continue;
      const leftToRight = b.x >= a.x;
      const x1 = leftToRight ? a.x + ca.width : a.x;
      const x2 = leftToRight ? b.x : b.x + cb.width;
      const y1 = a.y + ca.height / 2;
      const y2 = b.y + cb.height / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (leftToRight ? 1 : -1);
      const path = svgEl('path', { d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, fill: 'none' },
        relation.confidence === 'inferred' ? 'ms-dg-edge ms-dg-edge-inferred' : 'ms-dg-edge');
      svg.appendChild(path);
      if (relation.field) {
        const label = svgEl('text', { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, 'text-anchor': 'middle' }, 'ms-dg-edge-label');
        label.textContent = relation.field;
        svg.appendChild(label);
      }
    }
  }

  function drawCard(svg: SVGElement, card: Card, at: Point): void {
    const group = svgEl('g', { transform: `translate(${at.x} ${at.y})` }, 'ms-dg-node');
    group.appendChild(svgEl('rect', { x: 0, y: 0, width: card.width, height: card.height, rx: 8 }, card.inferred ? 'ms-dg-card ms-dg-card-inferred' : 'ms-dg-card'));
    const title = svgEl('text', { x: 10, y: 18 }, 'ms-dg-title');
    title.textContent = card.label;
    group.appendChild(title);
    card.fields.forEach((field, index) => {
      const row = svgEl('text', { x: 10, y: HEADER + index * ROW + 12 }, 'ms-dg-field');
      row.textContent = `${field.name}  ${field.type}${field.pk ? ' · pk' : ''}${field.required ? ' · *' : ''}`;
      group.appendChild(row);
    });
    if (card.more > 0) {
      const more = svgEl('text', { x: 10, y: HEADER + card.fields.length * ROW + 12 }, 'ms-dg-field ms-muted');
      more.textContent = `+${card.more} more`;
      group.appendChild(more);
    }
    svg.appendChild(group);
  }

  function attachPanZoom(svg: SVGElement): void {
    const apply = (): void => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    svg.addEventListener('wheel', (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = view.x + ((event.clientX - rect.left) / rect.width) * view.w;
      const py = view.y + ((event.clientY - rect.top) / rect.height) * view.h;
      const k = event.deltaY > 0 ? 1.1 : 1 / 1.1;
      view = { x: px - (px - view.x) * k, y: py - (py - view.y) * k, w: view.w * k, h: view.h * k };
      apply();
    }, { passive: false });
    let drag: { x: number; y: number; vx: number; vy: number } | null = null;
    svg.addEventListener('pointerdown', (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', (event: PointerEvent) => {
      if (drag === null) return;
      const rect = svg.getBoundingClientRect();
      view = {
        ...view,
        x: drag.vx - ((event.clientX - drag.x) / rect.width) * view.w,
        y: drag.vy - ((event.clientY - drag.y) / rect.height) * view.h,
      };
      apply();
    });
    svg.addEventListener('pointerup', () => { drag = null; });
  }

  function render(): void {
    setInfo();
    agentSlot.hidden = !(report !== null && report.collections.length === 0 && !loading);
    if (report === null || loading) return;
    const byName = new Map(report.collections.map((c) => [c.name, c]));
    const groups = groupShards(report.collections.map((c) => c.name));
    const groupOf = new Map<string, string>();
    for (const group of groups) for (const member of group.members) groupOf.set(member, group.id);
    focus.update({ options: groups.map((g) => ({ id: g.id, label: g.label })) });
    const relations = report.relations.filter((r) => showInferred || r.confidence === 'declared');
    const edges: Edge[] = relations
      .map((r) => ({ from: groupOf.get(r.from) ?? '', to: groupOf.get(r.to) ?? '' }))
      .filter((e) => e.from !== '' && e.to !== '' && e.from !== e.to);
    const groupIds = groups.map((g) => g.id);
    let visible: Set<string> | null;
    if (query.trim() !== '') {
      const names = new Set(searchNames([...byName.keys()], query));
      const matched = groups.filter((g) => g.id.toLowerCase().includes(query.trim().toLowerCase()) || g.members.some((m) => names.has(m)));
      visible = new Set(matched.flatMap((g) => [...neighborhood(edges, g.id, 1)]));
    } else if (center !== null) {
      visible = neighborhood(edges, center, hops);
    } else {
      visible = groupIds.length <= MAX_VISIBLE ? new Set(groupIds) : null;
    }
    for (const handle of canvasHandles.splice(0)) handle.dispose();
    canvas.replaceChildren();
    if (visible === null) {
      canvas.appendChild(emptyNode(`Dự án có ${groupIds.length} bảng. Tìm tên bảng hoặc chọn bảng trung tâm để xem sơ đồ.`));
      return;
    }
    const shown = groups.filter((g) => visible?.has(g.id)).slice(0, MAX_VISIBLE);
    if (shown.length === 0) {
      canvas.appendChild(emptyNode(report.collections.length === 0
        ? 'Chưa tìm thấy model MongoDB trong mã nguồn.'
        : 'Không có bảng nào khớp bộ lọc. Xoá lọc hoặc đổi từ khoá.'));
      return;
    }
    drawCanvas(shown, edges, relations, byName, groupOf);
  }

  function emptyNode(body: string): HTMLElement {
    const node = slot('ms-slot');
    const missing = report !== null && report.collections.length === 0;
    canvasHandles.push(mountEmpty(node, {
      title: missing ? 'Chưa có sơ đồ' : 'Lọc sơ đồ',
      body,
      action: missing && !hasAgent ? { label: 'Nhờ agent bổ sung', onClick: () => void askAgent() } : undefined,
    }));
    return node;
  }

  function drawCanvas(
    shown: ReturnType<typeof groupShards>,
    edges: Edge[],
    relations: SchemaRelation[],
    byName: Map<string, SchemaCollection>,
    groupOf: Map<string, string>,
  ): void {
    const cards = cardsOf(shown, byName);
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const visibleEdges = edges.filter((e) => cardById.has(e.from) && cardById.has(e.to));
    const positions = layout(cards.map((c) => ({ id: c.id, width: c.width, height: c.height })), visibleEdges);
    const key = cards.map((c) => c.id).sort().join('|');
    if (key !== viewKey) {
      viewKey = key;
      fitView(positions, cards);
    }
    const svg = svgEl('svg', { viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`, role: 'img', 'aria-label': 'Sơ đồ collection' }, 'ms-diagram-svg');
    drawEdges(svg, relations, positions, cardById, groupOf);
    for (const card of cards) {
      const at = positions.get(card.id);
      if (at) drawCard(svg, card, at);
    }
    attachPanZoom(svg);
    canvas.appendChild(svg);
  }

  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && fullscreen) toggleFullscreen();
  });
  void load();

  return {
    element: root,
    dispose() {
      disposed = true;
      for (const handle of [...handles, ...canvasHandles]) handle.dispose();
      canvasHandles.length = 0;
      bannerHandle?.dispose();
      root.remove();
    },
  };
}
