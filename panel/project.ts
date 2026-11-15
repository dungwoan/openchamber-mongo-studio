/**
 * Tự kết nối theo dự án. Khi OpenChamber có thư mục dự án, nhờ service nối tới database của dự án
 * (connection đã nhớ, hoặc cấu hình trong .env / docker-compose). Banner nói rõ đã làm gì và có nút Ngắt;
 * Ngắt thì lần mở sau không tự nối nữa, cho tới khi người dùng chọn lại connection trong cây.
 */
import { mountBanner } from '@openchamber/sdk/ui';

import type { ProjectConnectionView, ProjectConnectResponse } from '../shared/api.ts';
import type { Api, GuestHost } from './api.ts';
import { messageOf } from './context.ts';
import { emit, expandConnection, forgetConnectionCache, loadConnections, tree } from './state.ts';

type BannerProps = Parameters<typeof mountBanner>[1];
type Handle = { dispose(): void };

type Options = {
  host: GuestHost;
  api: Api;
  /** Ô trên thanh tiêu đề để hiện banner. */
  slot: HTMLElement;
};

/** Mô tả nơi kết nối đến, ví dụ "db1:27017/shop". Không có URI, chỉ có host và database. */
function whereOf(connection: ProjectConnectionView): string {
  return connection.db === '' ? connection.host : `${connection.host}/${connection.db}`;
}

/** Banner sau khi tự nối thành công, kèm nút Ngắt. */
function connectedBanner(connection: ProjectConnectionView, onDisconnect: () => void): BannerProps {
  const title = connection.source === 'remembered'
    ? `Đã tự nối lại connection "${connection.name}"`
    : `Đã tự kết nối — ${whereOf(connection)} (từ ${connection.sourceFile ?? 'file cấu hình'} của dự án)`;
  return {
    tone: 'success',
    title,
    body: connection.source === 'remembered'
      ? `${whereOf(connection)}. Ngắt thì lần mở sau sẽ không tự nối nữa.`
      : 'Ngắt thì lần mở sau sẽ không tự nối nữa, cho tới khi bạn chọn lại connection trong cây.',
    action: { label: 'Ngắt', onClick: onDisconnect },
  };
}

/** Tiêu đề và hướng xử lý khi không nối được. Thông báo từ service đã không chứa URI. */
function errorBanner(reply: Extract<ProjectConnectResponse, { status: 'error' }>): BannerProps {
  const title = reply.source === 'remembered'
    ? `Không tự nối lại được connection "${reply.name ?? ''}"`
    : reply.code === 'INVALID_URI'
      ? `Chuỗi kết nối trong ${reply.sourceFile ?? 'file cấu hình'} không hợp lệ`
      : `Không tự kết nối được (từ ${reply.sourceFile ?? 'file cấu hình'})`;
  // Thông báo host không phân giải được đã có sẵn hướng xử lý; các lỗi khác thêm hướng chung.
  const body = reply.code === 'UNRESOLVABLE_HOST'
    ? reply.error
    : `${reply.error} Sửa cấu hình rồi mở lại panel, hoặc chọn connection khác trong cây.`;
  return { tone: 'error', title, body };
}

/**
 * Gắn banner tự kết nối vào slot và theo dõi thư mục dự án.
 *
 * Args:
 *   options: Client OpenChamber, API service và ô hiển thị banner.
 */
export function startProjectConnect(options: Options): void {
  const { host, api, slot } = options;
  let seq = 0;
  let handle: Handle | null = null;

  const clear = (): void => {
    handle?.dispose();
    handle = null;
    slot.replaceChildren();
    slot.hidden = true;
  };

  const show = (props: BannerProps): void => {
    handle?.dispose();
    slot.replaceChildren();
    slot.hidden = false;
    handle = mountBanner(slot, props);
  };

  const disconnect = async (directory: string, connectionId: string): Promise<void> => {
    try {
      await api.call('/project/disconnect', { directory });
    } catch (error) {
      show({ tone: 'error', title: 'Không ngắt được kết nối', body: messageOf(error) });
      return;
    }
    if (tree.directory !== directory) return;
    forgetConnectionCache(connectionId);
    tree.expandedConnections.delete(connectionId);
    emit();
    await loadConnections(api);
    show({
      tone: 'info',
      title: 'Đã ngắt kết nối tự động',
      body: 'Lần mở sau sẽ không tự nối. Chọn connection trong cây để nối lại.',
    });
  };

  const autoConnect = async (directory: string, mine: number): Promise<void> => {
    let reply: ProjectConnectResponse;
    try {
      reply = await api.call<ProjectConnectResponse>('/project/open', { directory });
    } catch {
      return; // Service chưa bật hoặc không trả lời: không đổi gì so với hiện tại.
    }
    if (mine !== seq || reply.status === 'none') return;
    if (reply.status === 'error') {
      show(errorBanner(reply));
      return;
    }
    await loadConnections(api);
    if (mine !== seq) return;
    const { connection } = reply;
    expandConnection(api, connection.id);
    show(connectedBanner(connection, () => void disconnect(directory, connection.id)));
  };

  const apply = (directory: string | null): void => {
    if (directory === tree.directory) return;
    seq += 1;
    tree.directory = directory;
    clear();
    void loadConnections(api);
    if (directory !== null) void autoConnect(directory, seq);
  };

  host.onDirectory(apply);
}
