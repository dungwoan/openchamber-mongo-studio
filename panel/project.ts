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
    ? `Reconnected automatically to connection "${connection.name}"`
    : `Connected automatically — ${whereOf(connection)} (from ${connection.sourceFile ?? 'config file'} in the project)`;
  return {
    tone: 'success',
    title,
    body: connection.source === 'remembered'
      ? `${whereOf(connection)}. If you disconnect, it will not reconnect automatically next time.`
      : 'If you disconnect, it will not reconnect automatically next time, until you pick the connection in the tree again.',
    action: { label: 'Disconnect', onClick: onDisconnect },
  };
}

/** Tiêu đề và hướng xử lý khi không nối được. Thông báo từ service đã không chứa URI. */
function errorBanner(reply: Extract<ProjectConnectResponse, { status: 'error' }>): BannerProps {
  const title = reply.source === 'remembered'
    ? `Could not reconnect automatically to connection "${reply.name ?? ''}"`
    : reply.code === 'INVALID_URI'
      ? `The connection string in ${reply.sourceFile ?? 'config file'} is invalid`
      : `Could not connect automatically (from ${reply.sourceFile ?? 'config file'})`;
  // Thông báo host không phân giải được đã có sẵn hướng xử lý; các lỗi khác thêm hướng chung.
  const body = reply.code === 'UNRESOLVABLE_HOST'
    ? reply.error
    : `${reply.error} Fix the configuration and reopen the panel, or pick another connection in the tree.`;
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
      show({ tone: 'error', title: 'Could not disconnect', body: messageOf(error) });
      return;
    }
    if (tree.directory !== directory) return;
    forgetConnectionCache(connectionId);
    tree.expandedConnections.delete(connectionId);
    emit();
    await loadConnections(api);
    show({
      tone: 'info',
      title: 'Automatic connection turned off',
      body: 'It will not connect automatically next time. Pick the connection in the tree to connect again.',
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
    emit();
    clear();
    void loadConnections(api);
    if (directory !== null) void autoConnect(directory, seq);
  };

  host.onDirectory(apply);
}
