/**
 * Tab Sơ đồ: vẽ các collection và quan hệ bằng SVG tự dựng. Mọi nội dung đi qua textContent (không innerHTML).
 * Thẻ kéo được bằng header; vị trí giữ trong bộ nhớ phiên (không localStorage). Pan/zoom nằm trên nền khung.
 * Quá 80 bảng thì chỉ vẽ khi có tìm kiếm hoặc chọn bảng trung tâm (N bước).
 */
import { mountBanner, mountButton, mountEmpty, mountSearchField, mountSelect, mountSwitch } from '@openchamber/sdk/ui';

import type {
  DiagramGetResponse,
  DiagramLayoutGetResponse,
  DiagramLayoutSaveResponse,
  DiagramScanResponse,
  SchemaCollection,
  SchemaReport,
  SchemaRelation,
} from '../shared/api.ts';
import {
  applyOverrides,
  edgeGeometry,
  filterRelations,
  groupShards,
  layout,
  neighborhood,
  resolveDrop,
  searchNames,
  type Edge,
  type Point,
} from './diagram-layout.ts';
import type { Ctx } from './context.ts';
import { messageOf } from './context.ts';
import { confirmDialog } from './dialogs.ts';
import { append, h, slot } from './dom.ts';

const MAX_VISIBLE = 80;
const CARD_WIDTH = 240;
const HEADER = 26;
const ROW = 18;
const MAX_FIELDS = 12;
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_DECLARED = 'ms-dg-arrow-declared';
const ARROW_INFERRED = 'ms-dg-arrow-inferred';
/** Thời gian chờ sau khi thả thẻ trước khi ghi layout.json (gom nhiều lần kéo). */
const SAVE_DELAY_MS = 400;

type Handle = { dispose(): void };
type Card = { id: string; label: string; width: number; height: number; fields: SchemaCollection['fields']; more: number; inferred: boolean };
type EdgeView = { path: SVGPathElement; label: SVGTextElement; labelBg: SVGRectElement; from: string; to: string; text: string };
type Scene = { cards: Map<string, Card>; positions: Map<string, Point>; nodes: Map<string, SVGGElement>; edges: EdgeView[] };

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
    '- Chỉ đưa vào những gì có trong mã nguồn; dùng confidence "inferred" khi chỉ suy ra từ tên field.',
    'Sau khi ghi xong, báo lại số collection và số quan hệ đã ghi.',
  ].join('\n');
}

function svgEl(tag: string, attrs: Record<string, string | number>, className?: string): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}

function cardsOf(groups: ReturnType<typeof groupShards>, byName: Map<string, SchemaCollection>): Card[] {
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
      height: HEADER + 6 + rows * ROW + 6,
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
  let showRelations = true;
  let query = '';
  let center: string | null = null;
  let hops = 1;
  let fullscreen = false;
  let gitignore: DiagramScanResponse['gitignore'] | null = null;
  let disposed = false;
  let loadSeq = 0;
  let viewKey = '';
  let view = { x: 0, y: 0, w: 1000, h: 600 };
  /** Vị trí thẻ đã kéo trong phiên; "Sắp xếp lại" xoá. */
  const manual = new Map<string, Point>();
  let scene: Scene | null = null;
  let layoutLoaded = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Khoá (tên collection hoặc nhóm shard) của lần vẽ gần nhất; dùng để bỏ vị trí của bảng không còn tồn tại. */
  let knownKeys: Set<string> | null = null;

  const toolbarSlot = (parent: HTMLElement): HTMLDivElement => {
    const node = slot('ms-slot ms-slot-inline');
    parent.appendChild(node);
    return node;
  };

  const scanButton = mountButton(toolbarSlot(rowA), { label: 'Quét lại', variant: 'outline', size: 'sm', onClick: () => void scan(false) });
  const writeButton = mountButton(toolbarSlot(rowA), { label: 'Ghi báo cáo dự án', variant: 'secondary', size: 'sm', onClick: () => void scan(true) });
  // Công tắc có trạng thái do caller giữ: phải commit giá trị đề xuất bằng update, nếu không prop không đổi và click luôn đề xuất true.
  const relationSwitch = mountSwitch(toolbarSlot(rowA), {
    label: 'Hiển thị quan hệ',
    description: 'Vẽ cạnh giữa các bảng',
    checked: showRelations,
    onChange: (checked: boolean) => {
      showRelations = checked;
      relationSwitch.update({ checked });
      render();
    },
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
  const arrange = mountButton(toolbarSlot(rowB), {
    label: 'Sắp xếp lại',
    variant: 'ghost',
    size: 'sm',
    onClick: () => { manual.clear(); render(); void persist(); },
  });
  handles.push(scanButton, writeButton, relationSwitch, fullButton, agentButton, search, focus, hopsSelect, clear, arrange);

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

  /** Đọc layout.json lần đầu (sau đó bộ nhớ phiên là nguồn đúng). Lỗi chỉ thông báo, không chặn sơ đồ. */
  async function loadLayout(): Promise<DiagramLayoutGetResponse | null> {
    if (layoutLoaded) return null;
    try {
      return await ctx.api.call<DiagramLayoutGetResponse>('/diagram/layout/get', { directory });
    } catch (error) {
      if (!disposed) ctx.toast('error', `Không đọc được vị trí đã lưu: ${messageOf(error)}`);
      return null;
    }
  }

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    try {
      const [reply, saved] = await Promise.all([
        ctx.api.call<DiagramGetResponse>('/diagram/get', { directory }),
        loadLayout(),
      ]);
      if (disposed || seq !== loadSeq) return;
      if (saved !== null) {
        for (const [key, point] of Object.entries(saved.positions)) if (!manual.has(key)) manual.set(key, point);
        layoutLoaded = true;
      }
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

  /** Quét lại (write=false) hoặc ghi báo cáo vào dự án (write=true, một lần bấm). */
  async function scan(write: boolean): Promise<void> {
    try {
      const reply = await ctx.api.call<DiagramScanResponse>('/diagram/scan', { directory, write });
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
      + `${report.truncated ? ' · đã cắt bớt' : ''}${hasAgent ? ' · có bổ sung của agent' : ''}`
      + ' · nét liền: khai báo trong code; nét đứt: suy ra từ tên field';
    const lines: string[] = [];
    if (gitignore === 'missing') lines.push('Gợi ý: thêm dòng ".openchamber/" vào .gitignore của dự án (Mongo Studio không tự sửa file này).');
    if (gitignore === 'absent') lines.push('Dự án chưa có .gitignore; nếu dùng git, nên thêm ".openchamber/".');
    lines.push(...report.warnings.slice(0, 3));
    notes.textContent = lines.join(' ');
  }

  /** Khung nhìn 1:1 (kích thước thật của canvas) neo ở góc trên trái của sơ đồ; kéo hoặc cuộn để xem phần còn lại. */
  /** Ghi vị trí đang có vào layout.json. Lỗi chỉ báo toast; vị trí trên màn hình vẫn giữ. */
  async function persist(): Promise<void> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const positions: Record<string, Point> = {};
    for (const [key, point] of manual) {
      if (knownKeys === null || knownKeys.has(key)) positions[key] = { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
    }
    try {
      await ctx.api.call<DiagramLayoutSaveResponse>('/diagram/layout/save', { directory, positions });
    } catch (error) {
      ctx.toast('error', `Không lưu được vị trí sơ đồ: ${messageOf(error)}`);
    }
  }

  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persist(), SAVE_DELAY_MS);
  }

  function placeNode(id: string, point: Point): void {
    if (scene === null) return;
    scene.positions.set(id, point);
    manual.set(id, point);
    scene.nodes.get(id)?.setAttribute('transform', `translate(${point.x} ${point.y})`);
    updateEdges();
  }

  function fitView(positions: Map<string, Point>, cards: Card[]): void {
    const minX = Math.min(...cards.map((card) => positions.get(card.id)?.x ?? 0));
    const minY = Math.min(...cards.map((card) => positions.get(card.id)?.y ?? 0));
    view = { x: minX - 20, y: minY - 20, w: canvas.clientWidth || 700, h: canvas.clientHeight || 480 };
  }

  /** Vẽ lại đường nối và nhãn của mọi cạnh theo vị trí hiện tại (dùng khi kéo thẻ, không dựng lại SVG). */
  function updateEdges(): void {
    if (scene === null) return;
    for (const edge of scene.edges) {
      const a = scene.cards.get(edge.from);
      const b = scene.cards.get(edge.to);
      const pa = scene.positions.get(edge.from);
      const pb = scene.positions.get(edge.to);
      if (!a || !b || !pa || !pb) continue;
      const geometry = edgeGeometry({ x: pa.x, y: pa.y, width: a.width, height: a.height }, { x: pb.x, y: pb.y, width: b.width, height: b.height });
      edge.path.setAttribute('d', geometry.d);
      const textWidth = edge.text.length * 6 + 10;
      edge.label.setAttribute('x', String(geometry.labelX));
      edge.label.setAttribute('y', String(geometry.labelY + 4));
      edge.labelBg.setAttribute('x', String(geometry.labelX - textWidth / 2));
      edge.labelBg.setAttribute('y', String(geometry.labelY - 9));
    }
  }

  function drawEdges(svg: SVGElement, relations: SchemaRelation[], groupOf: Map<string, string>, cardIds: Set<string>): EdgeView[] {
    const drawn: EdgeView[] = [];
    for (const relation of relations) {
      const from = groupOf.get(relation.from);
      const to = groupOf.get(relation.to);
      if (!from || !to || from === to || !cardIds.has(from) || !cardIds.has(to)) continue;
      const inferred = relation.confidence === 'inferred';
      const path = svgEl('path', { fill: 'none', 'marker-end': `url(#${inferred ? ARROW_INFERRED : ARROW_DECLARED})` },
        inferred ? 'ms-dg-edge ms-dg-edge-inferred' : 'ms-dg-edge ms-dg-edge-declared') as SVGPathElement;
      const labelBg = svgEl('rect', { width: 0, height: 14, rx: 3 }, 'ms-dg-edge-labelbg') as SVGRectElement;
      const label = svgEl('text', { 'text-anchor': 'middle' }, 'ms-dg-edge-label') as SVGTextElement;
      const text = relation.field ?? relation.kind;
      label.textContent = text;
      svg.append(path, labelBg, label);
      drawn.push({ path, label, labelBg, from, to, text });
    }
    return drawn;
  }

  function markers(): SVGElement {
    const defs = svgEl('defs', {});
    for (const [id, className] of [[ARROW_DECLARED, 'ms-dg-arrow-declared'], [ARROW_INFERRED, 'ms-dg-arrow-inferred']] as const) {
      const marker = svgEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z' }, className));
      defs.appendChild(marker);
    }
    return defs;
  }

  function drawCard(svg: SVGElement, card: Card, at: Point, nodes: Map<string, SVGGElement>): void {
    const group = svgEl('g', { transform: `translate(${at.x} ${at.y})` }, 'ms-dg-node') as SVGGElement;
    group.appendChild(svgEl('rect', { x: 0, y: 0, width: card.width, height: card.height, rx: 8 },
      card.inferred ? 'ms-dg-card ms-dg-card-inferred' : 'ms-dg-card'));
    card.fields.forEach((_field, index) => {
      const top = HEADER + 6 + index * ROW;
      if (index % 2 === 1) group.appendChild(svgEl('rect', { x: 1, y: top, width: card.width - 2, height: ROW }, 'ms-dg-row-alt'));
    });
    const header = svgEl('rect', { x: 0, y: 0, width: card.width, height: HEADER, rx: 8 }, 'ms-dg-header');
    group.appendChild(header);
    const title = svgEl('text', { x: 10, y: 17 }, 'ms-dg-title');
    title.textContent = card.label;
    group.appendChild(title);
    group.appendChild(svgEl('line', { x1: 0, y1: HEADER, x2: card.width, y2: HEADER }, 'ms-dg-sep'));
    card.fields.forEach((field, index) => {
      const baseline = HEADER + 6 + index * ROW + 13;
      if (field.pk) {
        const pk = svgEl('text', { x: 10, y: baseline }, 'ms-dg-pk');
        pk.textContent = 'PK';
        group.appendChild(pk);
      }
      const name = svgEl('text', { x: 34, y: baseline }, field.required ? 'ms-dg-name ms-dg-req' : 'ms-dg-name');
      name.textContent = field.name;
      group.appendChild(name);
      const typeClass = field.type === 'mixed' ? 'ms-dg-type ms-dg-type-mixed' : 'ms-dg-type';
      const type = svgEl('text', { x: card.width - 10, y: baseline, 'text-anchor': 'end' }, typeClass);
      type.textContent = field.array ? `${field.type}[]` : field.type;
      group.appendChild(type);
    });
    if (card.more > 0) {
      const more = svgEl('text', { x: 10, y: HEADER + 6 + card.fields.length * ROW + 13 }, 'ms-dg-more');
      more.textContent = `+${card.more} more`;
      group.appendChild(more);
    }
    header.addEventListener('pointerdown', (event: PointerEvent) => {
      event.stopPropagation();
      drag = { id: card.id, startX: event.clientX, startY: event.clientY, origin: { ...(scene?.positions.get(card.id) ?? { x: at.x, y: at.y }) }, moved: false };
      svg.setPointerCapture(event.pointerId);
    });
    nodes.set(card.id, group);
    svg.appendChild(group);
  }

  let drag: { id: string; startX: number; startY: number; origin: Point; moved: boolean } | null = null;
  let pan: { x: number; y: number; vx: number; vy: number } | null = null;

  function attachInteractions(svg: SVGElement): void {
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
    svg.addEventListener('pointerdown', (event: PointerEvent) => {
      pan = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', (event: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      if (drag !== null && scene !== null) {
        const dx = ((event.clientX - drag.startX) / rect.width) * view.w;
        const dy = ((event.clientY - drag.startY) / rect.height) * view.h;
        if (dx !== 0 || dy !== 0) drag.moved = true;
        placeNode(drag.id, { x: drag.origin.x + dx, y: drag.origin.y + dy });
        return;
      }
      if (pan === null) return;
      view = {
        ...view,
        x: pan.vx - ((event.clientX - pan.x) / rect.width) * view.w,
        y: pan.vy - ((event.clientY - pan.y) / rect.height) * view.h,
      };
      apply();
    });
    const release = (): void => {
      if (drag !== null && drag.moved && scene !== null) {
        // Chỉ khi thả: đẩy thẻ đè sang vị trí trống gần nhất, rồi lên lịch ghi layout.
        const sizes = new Map([...scene.cards].map(([key, card]) => [key, { width: card.width, height: card.height }]));
        const landed = resolveDrop(drag.id, scene.positions, sizes);
        const current = scene.positions.get(drag.id);
        if (current && (landed.x !== current.x || landed.y !== current.y)) placeNode(drag.id, landed);
        scheduleSave();
      }
      drag = null;
      pan = null;
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
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
    const relations = filterRelations(report.relations, showRelations);
    const edges: Edge[] = relations
      .map((r) => ({ from: groupOf.get(r.from) ?? '', to: groupOf.get(r.to) ?? '' }))
      .filter((e) => e.from !== '' && e.to !== '' && e.from !== e.to);
    const groupIds = groups.map((g) => g.id);
    knownKeys = new Set(groupIds);
    let visible: Set<string> | null;
    if (query.trim() !== '') {
      const names = new Set(searchNames([...byName.keys()], query));
      const needle = query.trim().toLowerCase();
      const matched = groups.filter((g) => g.id.toLowerCase().includes(needle) || g.members.some((m) => names.has(m)));
      visible = new Set(matched.flatMap((g) => [...neighborhood(edges, g.id, 1)]));
    } else if (center !== null) {
      visible = neighborhood(edges, center, hops);
    } else {
      visible = groupIds.length <= MAX_VISIBLE ? new Set(groupIds) : null;
    }
    for (const handle of canvasHandles.splice(0)) handle.dispose();
    canvas.replaceChildren();
    scene = null;
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
    const auto = layout(cards.map((c) => ({ id: c.id, width: c.width, height: c.height })), visibleEdges);
    const positions = applyOverrides(auto, new Map([...manual].filter(([id]) => cardById.has(id))));
    const key = cards.map((c) => c.id).sort().join('|');
    if (key !== viewKey) {
      viewKey = key;
      fitView(positions, cards);
    }
    const svg = svgEl('svg', { viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`, role: 'img', 'aria-label': 'Sơ đồ collection' }, 'ms-diagram-svg') as SVGSVGElement;
    svg.appendChild(markers());
    const nodes = new Map<string, SVGGElement>();
    const sceneEdges = drawEdges(svg, relations, groupOf, new Set(cardById.keys()));
    for (const card of cards) {
      const at = positions.get(card.id);
      if (at) drawCard(svg, card, at, nodes);
    }
    scene = { cards: cardById, positions, nodes, edges: sceneEdges };
    updateEdges();
    attachInteractions(svg);
    canvas.appendChild(svg);
  }

  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && fullscreen) toggleFullscreen();
  });
  void load();

  return {
    element: root,
    dispose() {
      if (saveTimer !== null) void persist();
      disposed = true;
      for (const handle of [...handles, ...canvasHandles]) handle.dispose();
      canvasHandles.length = 0;
      bannerHandle?.dispose();
      root.remove();
    },
  };
}
