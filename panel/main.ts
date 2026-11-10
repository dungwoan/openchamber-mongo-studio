/**
 * Entry point của panel Mongo Studio. Panel chạy trong iframe sandbox: không có mạng,
 * mọi dữ liệu đi qua host.serviceRequest tới service.
 */
import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import { createApi } from './api.ts';
import { startWorkspace } from './workspace.ts';

const host = connectHost();
const root = document.getElementById('root');

if (!root) {
  throw new Error('Thiếu phần tử #root trong panel/index.html');
}

let started = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (started) return;
  started = true;
  startWorkspace({ host, api: createApi(host), root });
});
