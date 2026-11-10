/**
 * Hộp thoại thêm hoặc sửa connection. URI là ô mật khẩu: không bao giờ hiển thị lại URI đã lưu.
 */
import { mountBanner, mountButton, mountCheckbox, mountTextField } from '@openchamber/sdk/ui';

import type { ConnectionResponse, ConnectionView, TestConnectionResponse } from '../shared/api.ts';
import { ApiError } from './api.ts';
import type { Ctx } from './context.ts';
import { append, h, slot } from './dom.ts';
import { openDialog } from './dialogs.ts';

/** Hướng xử lý theo mã lỗi kết nối, để người dùng biết cần kiểm tra gì. */
const HINTS: Record<string, string> = {
  UNREACHABLE: 'Kiểm tra host, port, tường lửa (firewall) và MongoDB có đang chạy không.',
  NETWORK: 'Kiểm tra mạng hoặc VPN tới máy chủ MongoDB.',
  AUTH_FAILED: 'Kiểm tra user, password và authSource trong URI.',
  INVALID_URI: 'Kiểm tra lại định dạng URI: mongodb://user:pass@host:27017/?authSource=admin.',
  UNAUTHORIZED: 'Kiểm tra quyền (role) của user trong MongoDB.',
};

type FormState = { name: string; uri: string; readOnly: boolean };

/**
 * Mở hộp thoại thêm (existing = null) hoặc sửa connection.
 *
 * Args:
 *   ctx: Context dùng chung.
 *   existing: Connection đang sửa, hoặc null khi thêm mới.
 *   onSaved: Gọi sau khi lưu thành công với connection mới.
 */
export function openConnectionDialog(ctx: Ctx, existing: ConnectionView | null, onSaved: (connection: ConnectionView) => void): void {
  const state: FormState = { name: existing?.name ?? '', uri: '', readOnly: existing?.readOnly ?? false };
  const dialog = openDialog(existing ? `Edit connection · ${existing.name}` : 'Add connection', false);
  const { body } = dialog;

  const nameSlot = slot();
  const uriSlot = slot();
  const checkSlot = slot();
  const statusSlot = slot('ms-slot ms-slot-banner');
  const actions = h('div', 'ms-dialog-actions');
  const testSlot = slot('ms-slot ms-slot-inline');
  const cancelSlot = slot('ms-slot ms-slot-inline');
  const saveSlot = slot('ms-slot ms-slot-inline');
  append(actions, testSlot, cancelSlot, saveSlot);
  append(body, nameSlot, uriSlot, checkSlot, statusSlot, actions);

  let status: ReturnType<typeof mountBanner> | null = null;
  const showStatus = (tone: 'success' | 'error' | 'info', title: string, text?: string): void => {
    if (!status) status = mountBanner(statusSlot, { tone, title, body: text });
    else status.update({ tone, title, body: text });
  };

  mountTextField(nameSlot, {
    label: 'Name',
    value: state.name,
    placeholder: 'Ví dụ: Production CRM',
    onChange: (value) => { state.name = value; },
  });
  mountTextField(uriSlot, {
    label: 'URI',
    value: '',
    password: true,
    mono: true,
    placeholder: existing ? 'Để trống để giữ URI đã lưu' : 'mongodb://user:password@host:27017/?authSource=admin',
    helper: existing
      ? 'URI đã lưu không hiển thị lại. Chỉ nhập khi muốn thay đổi.'
      : 'Hỗ trợ mongodb:// và mongodb+srv://. URI được lưu trên máy này (file 0600).',
    onChange: (value) => { state.uri = value; },
  });
  mountCheckbox(checkSlot, {
    label: 'Read-only',
    description: 'Chặn mọi thao tác thêm, sửa, xoá và lệnh ghi. Nên bật cho môi trường production.',
    checked: state.readOnly,
    onChange: (checked) => { state.readOnly = checked; },
  });

  let testing = false;
  mountButton(testSlot, {
    label: 'Test connection',
    variant: 'outline',
    onClick: () => {
      if (testing) return;
      testing = true;
      showStatus('info', 'Đang kiểm tra kết nối…');
      void testConnection(ctx, existing, state.uri).then(
        (result) => {
          testing = false;
          if (result.ok) {
            showStatus('success', `Kết nối thành công · MongoDB ${result.version}`, `Phản hồi trong ${result.elapsedMs} ms.`);
          } else {
            showStatus('error', result.error, HINTS[result.code] ?? 'Kiểm tra lại URI rồi thử lại.');
          }
        },
        (error: unknown) => {
          testing = false;
          showStatus('error', error instanceof ApiError ? error.message : 'Không kiểm tra được kết nối', error instanceof ApiError ? HINTS[error.code] : undefined);
        },
      );
    },
  });
  mountButton(cancelSlot, { label: 'Cancel', variant: 'ghost', onClick: dialog.close });
  mountButton(saveSlot, {
    label: existing ? 'Save' : 'Add connection',
    onClick: () => {
      void save(ctx, existing, state, showStatus, (saved) => {
        dialog.close();
        onSaved(saved);
      });
    },
  });
}

async function testConnection(ctx: Ctx, existing: ConnectionView | null, uri: string): Promise<TestConnectionResponse> {
  const body: Record<string, unknown> = existing ? { id: existing.id } : {};
  if (uri.trim() !== '') body.uri = uri.trim();
  return ctx.api.call<TestConnectionResponse>('/connections/test', body);
}

async function save(
  ctx: Ctx,
  existing: ConnectionView | null,
  state: FormState,
  showStatus: (tone: 'success' | 'error' | 'info', title: string, text?: string) => void,
  done: (connection: ConnectionView) => void,
): Promise<void> {
  if (state.name.trim() === '') {
    showStatus('error', 'Cần nhập tên connection', 'Tên giúp bạn nhận ra connection trong cây bên trái.');
    return;
  }
  if (!existing && state.uri.trim() === '') {
    showStatus('error', 'Cần nhập URI', 'Dán chuỗi kết nối MongoDB, ví dụ mongodb://user:password@host:27017/.');
    return;
  }
  const body: Record<string, unknown> = { name: state.name.trim(), readOnly: state.readOnly };
  if (existing) body.id = existing.id;
  if (state.uri.trim() !== '') body.uri = state.uri.trim();
  try {
    const reply = await ctx.api.call<ConnectionResponse>('/connections/save', body);
    ctx.toast('success', `Đã lưu connection "${reply.connection.name}"`);
    done(reply.connection);
  } catch (error) {
    const message = error instanceof ApiError ? error.message : 'Không lưu được connection';
    const hint = error instanceof ApiError ? HINTS[error.code] ?? 'Kiểm tra lại thông tin rồi thử lại.' : undefined;
    showStatus('error', message, hint);
  }
}
