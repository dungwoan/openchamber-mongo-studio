/**
 * Hộp thoại dùng chung: khung có tiêu đề, và hộp xác nhận trước mọi thao tác ghi hoặc xoá.
 */
import { mountButton } from '@openchamber/sdk/ui';

import { append, h, slot } from './dom.ts';

export type DialogHandle = {
  root: HTMLElement;
  body: HTMLElement;
  close: () => void;
};

/**
 * Mở một hộp thoại. Esc hoặc nút × đóng hộp; bấm nền không đóng để tránh mất dữ liệu đang nhập.
 *
 * Args:
 *   title: Tiêu đề hiển thị.
 *   wide: true để hộp rộng hơn (cho editor JSON).
 *   onClose: Hàm gọi khi hộp đóng.
 *
 * Returns:
 *   Tham chiếu tới phần body để caller dựng nội dung.
 */
export function openDialog(title: string, wide: boolean, onClose: () => void = () => undefined): DialogHandle {
  const overlay = h('div', 'ms-overlay');
  const dialog = h('div', wide ? 'ms-dialog ms-dialog-wide' : 'ms-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);
  const header = h('div', 'ms-dialog-head');
  header.appendChild(h('h2', 'ms-dialog-title', title));
  const closeSlot = slot('ms-slot ms-slot-inline');
  header.appendChild(closeSlot);
  const body = h('div', 'ms-dialog-body');
  append(dialog, header, body);
  overlay.appendChild(dialog);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    onClose();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  mountButton(closeSlot, { label: 'Close', variant: 'ghost', size: 'xs', onClick: close });
  document.addEventListener('keydown', onKey, true);
  document.querySelector('#root')?.appendChild(overlay);
  return { root: dialog, body, close };
}

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
};

/**
 * Hộp xác nhận. Trả về true chỉ khi người dùng bấm nút xác nhận.
 *
 * Args:
 *   options: Tiêu đề, nội dung và nhãn nút.
 *
 * Returns:
 *   Promise<boolean> với kết quả người dùng chọn.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const finish = (value: boolean): void => {
      if (answered) return;
      answered = true;
      dialog.close();
      resolve(value);
    };
    const dialog = openDialog(options.title, false, () => finish(false));
    dialog.body.appendChild(h('p', 'ms-confirm-text', options.message));
    const actions = h('div', 'ms-dialog-actions');
    const cancel = slot('ms-slot ms-slot-inline');
    const confirm = slot('ms-slot ms-slot-inline');
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.body.appendChild(actions);
    mountButton(cancel, { label: 'Cancel', variant: 'outline', onClick: () => finish(false) });
    mountButton(confirm, {
      label: options.confirmLabel,
      variant: options.destructive ? 'destructive' : 'default',
      onClick: () => finish(true),
    });
  });
}
