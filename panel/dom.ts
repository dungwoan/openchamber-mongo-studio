/**
 * Helper DOM nhỏ. Không dùng innerHTML hay style inline: sandbox của page chặn style inline,
 * và textContent tránh được chèn HTML từ dữ liệu MongoDB.
 */

/** Tạo phần tử với class và nội dung text tuỳ chọn. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** Ô trống để gắn một control của UI kit vào. */
export function slot(className = 'ms-slot'): HTMLDivElement {
  return h('div', className);
}

/** Thêm nhiều phần tử con và trả về phần tử cha. */
export function append<T extends Element>(parent: T, ...children: Array<Node | null | undefined | false>): T {
  for (const child of children) {
    if (child) parent.appendChild(child);
  }
  return parent;
}

/** Nút thường (không dùng UI kit), chỉ dùng cho hàng trong cây và tab đóng. */
export function plainButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/** Thời gian tương đối đơn giản cho lịch sử, ví dụ "5 phút trước". */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return new Date(at).toLocaleDateString('vi-VN');
}

/** Số có dấu phân cách hàng nghìn theo kiểu en-US để dễ đọc và thống nhất. */
export function groupDigits(value: number): string {
  return value.toLocaleString('en-US');
}
