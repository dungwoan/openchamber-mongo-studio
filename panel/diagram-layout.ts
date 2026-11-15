/**
 * Thuật toán bố cục sơ đồ (thuần, không DOM): thành phần liên thông, lưới theo độ sâu, lân cận N bước,
 * gộp shard cdr_* và tìm kiếm tên. Không chồng thẻ: thành phần đặt cạnh nhau theo x, cột đặt theo x,
 * thẻ trong cột xếp theo y.
 */

export type Edge = { from: string; to: string };
export type Node = { id: string; width: number; height: number };
export type Point = { x: number; y: number };
export type Group = { id: string; label: string; members: string[] };

const GAP_X = 80;
const GAP_Y = 32;
const GAP_COMPONENT = 60;
/** Chiều rộng tối đa của một hàng thành phần; vượt thì xuống hàng dưới để sơ đồ không quá dẹt. */
const MAX_ROW_WIDTH = 1200;
const SHARD_PREFIX = 'cdr';

/** Các thành phần liên thông (bỏ qua cạnh tới id không tồn tại). */
export function components(ids: string[], edges: Edge[]): string[][] {
  const known = new Set(ids);
  const adjacent = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    adjacent.get(edge.from)?.add(edge.to);
    adjacent.get(edge.to)?.add(edge.from);
  }
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const part: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      part.push(current);
      for (const next of adjacent.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    result.push(part);
  }
  return result;
}

/** Độ sâu BFS (cạnh vô hướng) từ nút có bậc cao nhất trong thành phần; nút cùng bậc lấy theo id. */
function depthsOf(part: string[], edges: Edge[]): Map<string, number> {
  const inside = new Set(part);
  const adjacent = new Map<string, string[]>(part.map((id) => [id, []]));
  for (const edge of edges) {
    if (!inside.has(edge.from) || !inside.has(edge.to)) continue;
    adjacent.get(edge.from)?.push(edge.to);
    adjacent.get(edge.to)?.push(edge.from);
  }
  const root = [...part].sort((a, b) => (adjacent.get(b)?.length ?? 0) - (adjacent.get(a)?.length ?? 0) || (a < b ? -1 : 1))[0] as string;
  const depth = new Map<string, number>([[root, 0]]);
  const queue = [root];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] as string;
    for (const next of adjacent.get(current) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, (depth.get(current) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  return depth;
}

/**
 * Toạ độ góc trên trái của từng thẻ. Thành phần lớn nhất đứng trước, các thành phần đặt cạnh nhau.
 *
 * Args:
 *   nodes: Thẻ với kích thước.
 *   edges: Quan hệ giữa các thẻ.
 */
export function layout(nodes: Node[], edges: Edge[]): Map<string, Point> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parts = components(nodes.map((node) => node.id), edges).sort((a, b) => b.length - a.length);
  const positions = new Map<string, Point>();
  let rowX = 0;
  let rowY = 0;
  let rowBottom = 0;
  for (const part of parts) {
    const local = partLayout(part, edges, byId);
    if (rowX > 0 && rowX + local.width > MAX_ROW_WIDTH) {
      rowX = 0;
      rowY = rowBottom + GAP_COMPONENT;
      rowBottom = rowY;
    }
    for (const [id, point] of local.points) positions.set(id, { x: rowX + point.x, y: rowY + point.y });
    rowBottom = Math.max(rowBottom, rowY + local.height);
    rowX += local.width + GAP_COMPONENT;
  }
  return positions;
}

/** Bố cục một thành phần liên thông trong hệ toạ độ riêng (góc trên trái là 0,0). */
function partLayout(part: string[], edges: Edge[], byId: Map<string, Node>): { points: Map<string, Point>; width: number; height: number } {
  const depth = depthsOf(part, edges);
  const columns = new Map<number, string[]>();
  for (const id of part) {
    const column = depth.get(id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), id]);
  }
  const points = new Map<string, Point>();
  let x = 0;
  let height = 0;
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    const members = columns.get(column) ?? [];
    const width = Math.max(...members.map((id) => byId.get(id)?.width ?? 0));
    let y = 0;
    for (const id of members) {
      points.set(id, { x, y });
      y += (byId.get(id)?.height ?? 0) + GAP_Y;
    }
    height = Math.max(height, y - GAP_Y);
    x += width + GAP_X;
  }
  return { points, width: Math.max(0, x - GAP_X), height };
}

/** Các id trong phạm vi hops bước (hai chiều) quanh center, gồm chính center. */
export function neighborhood(edges: Edge[], center: string, hops: number): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    adjacent.set(edge.from, [...(adjacent.get(edge.from) ?? []), edge.to]);
    adjacent.set(edge.to, [...(adjacent.get(edge.to) ?? []), edge.from]);
  }
  const seen = new Set<string>([center]);
  let frontier = [center];
  for (let step = 0; step < hops; step += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * Gộp các bảng shard cdr_* (từ hai bảng trở lên) thành một nhóm "cdr_*"; các bảng khác là nhóm riêng.
 */
export function groupShards(names: string[]): Group[] {
  const shards = names.filter((name) => name.startsWith(`${SHARD_PREFIX}_`));
  const grouped = shards.length >= 2 ? new Set(shards) : new Set<string>();
  const groups: Group[] = [];
  if (grouped.size > 0) {
    const members = [...grouped].sort();
    groups.push({ id: `${SHARD_PREFIX}_*`, label: `${SHARD_PREFIX}_* (${members.length} bảng)`, members });
  }
  for (const name of names) {
    if (!grouped.has(name)) groups.push({ id: name, label: name, members: [name] });
  }
  return groups;
}

/** Tên chứa chuỗi tìm kiếm (không phân biệt hoa thường). Chuỗi rỗng thì giữ nguyên danh sách. */
export function searchNames(names: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return names;
  return names.filter((name) => name.toLowerCase().includes(needle));
}

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Đường cong nối hai thẻ: xuất phát từ cạnh gần nhất, tại tâm chiều cao của thẻ.
 * Nhãn quan hệ đặt ở giữa đường nối.
 */
export function edgeGeometry(from: Box, to: Box): { d: string; labelX: number; labelY: number } {
  const rightward = to.x >= from.x;
  const x1 = rightward ? from.x + from.width : from.x;
  const x2 = rightward ? to.x : to.x + to.width;
  const y1 = from.y + from.height / 2;
  const y2 = to.y + to.height / 2;
  const reach = Math.max(40, Math.abs(x2 - x1) / 2) * (rightward ? 1 : -1);
  return {
    d: `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2,
  };
}

/** Vị trí sau khi kéo: các thẻ có override dùng vị trí đó, còn lại giữ bố cục gốc. Không sửa bản gốc. */
export function applyOverrides(positions: Map<string, Point>, overrides: Map<string, Point>): Map<string, Point> {
  const merged = new Map(positions);
  for (const [id, point] of overrides) merged.set(id, { x: point.x, y: point.y });
  return merged;
}

/** Quan hệ được vẽ khi công tắc "Hiển thị quan hệ" bật; tắt thì không vẽ cạnh nào. */
export function filterRelations<T>(relations: T[], show: boolean): T[] {
  return show ? relations : [];
}
