/**
 * Mục "Diagrams" trong cột trái: dự án đang mở đứng đầu, rồi các dự án khác đang có tab sơ đồ mở.
 * Hàm thuần để kiểm thử; giao diện nằm trong workspace.ts.
 */

export type DiagramEntry = { directory: string; label: string; current: boolean };

/** Tên hiển thị của thư mục: thành phần cuối, bỏ dấu "/" thừa. */
export function labelOf(directory: string): string {
  const trimmed = directory.replace(/\/+$/, '');
  return trimmed.split('/').pop() || directory;
}

/**
 * Danh sách mục sơ đồ, không trùng (so sánh bỏ dấu "/" cuối).
 *
 * Args:
 *   current: Thư mục dự án đang mở, hoặc null.
 *   openDirectories: Thư mục có tab sơ đồ đang mở.
 */
export function diagramEntries(current: string | null, openDirectories: string[]): DiagramEntry[] {
  const seen = new Set<string>();
  const entries: DiagramEntry[] = [];
  const add = (directory: string, isCurrent: boolean): void => {
    const key = directory.replace(/\/+$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ directory, label: labelOf(directory), current: isCurrent });
  };
  if (current !== null) add(current, true);
  for (const directory of openDirectories) add(directory, false);
  return entries;
}
