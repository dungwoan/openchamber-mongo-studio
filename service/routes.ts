/**
 * Bảng route của service. Mọi route là POST với body JSON, trừ /health.
 * Hai đường dẫn @ mentions dùng đúng hằng số của SDK để OpenChamber gọi tới.
 */
import { MENTIONS_RESOLVE_PATH, MENTIONS_SEARCH_PATH } from '@openchamber/sdk';

import { collectionsRoute, databasesRoute, findRoute, indexesRoute } from './handlers/browse.ts';
import { deleteRoute as deleteConnectionRoute, disconnectRoute, listRoute, saveRoute, testRoute } from './handlers/connections.ts';
import { deleteRoute as deleteDocumentRoute, insertRoute, replaceRoute } from './handlers/documents.ts';
import { historyAddRoute, historyRoute, runRoute } from './handlers/query.ts';
import type { Body } from './validate.ts';
import { resolveRoute, searchRoute } from './mentions.ts';

export type Handler = (body: Body) => unknown;

export const ROUTES: Record<string, Handler> = {
  '/connections/list': listRoute,
  '/connections/save': saveRoute,
  '/connections/delete': deleteConnectionRoute,
  '/connections/disconnect': disconnectRoute,
  '/connections/test': testRoute,
  '/tree/databases': databasesRoute,
  '/tree/collections': collectionsRoute,
  '/collection/find': findRoute,
  '/collection/indexes': indexesRoute,
  '/documents/insert': insertRoute,
  '/documents/replace': replaceRoute,
  '/documents/delete': deleteDocumentRoute,
  '/query/run': runRoute,
  '/query/history': historyRoute,
  '/query/history/add': historyAddRoute,
  [MENTIONS_SEARCH_PATH]: searchRoute,
  [MENTIONS_RESOLVE_PATH]: resolveRoute,
};
