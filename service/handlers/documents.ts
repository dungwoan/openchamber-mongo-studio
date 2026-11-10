/**
 * Route thêm, sửa và xoá document theo _id. Mọi route đều bị chặn khi connection chỉ đọc.
 */
import type { Document } from 'mongodb';

import type { DeleteResponse, InsertResponse, ReplaceResponse } from '../../shared/api.ts';
import { numberOf, toBson, toJson } from '../ejson.ts';
import { badRequest, notFound } from '../errors.ts';
import { withDatabase } from '../pool.ts';
import { type Body, requireObject, requireString } from '../validate.ts';
import { assertWritable, connectionFrom, literalField } from './common.ts';

/** Đọc nội dung document người dùng nhập; chỉ nhận đối tượng, không nhận toán tử $ ở cấp trên cùng. */
function documentFrom(text: string, label: string): Document {
  const value = requireObject(literalField(text, label), label);
  if (Object.keys(value).some((key) => key.startsWith('$'))) {
    throw badRequest(`${label} không được có khoá bắt đầu bằng $ ở cấp cao nhất`);
  }
  return toBson(value) as Document;
}

/** Route /documents/insert. */
export async function insertRoute(body: Body): Promise<InsertResponse> {
  const record = await connectionFrom(body);
  assertWritable(record);
  const database = requireString(body, 'database', 255);
  const collection = requireString(body, 'collection', 255);
  const doc = documentFrom(requireString(body, 'document', 1_000_000), 'Document');
  const result = await withDatabase(record, database, (db) => db.collection(collection).insertOne(doc));
  return { insertedId: toJson(result.insertedId) };
}

/** Route /documents/replace: thay toàn bộ document có _id tương ứng. */
export async function replaceRoute(body: Body): Promise<ReplaceResponse> {
  const record = await connectionFrom(body);
  assertWritable(record);
  const database = requireString(body, 'database', 255);
  const collection = requireString(body, 'collection', 255);
  if (body.id === undefined || body.id === null) throw badRequest('Thiếu _id của document cần sửa');
  const id = toBson(body.id);
  const doc = documentFrom(requireString(body, 'document', 1_000_000), 'Document');
  const result = await withDatabase(record, database, (db) =>
    db.collection(collection).replaceOne({ _id: id } as Document, doc));
  if (numberOf(result.matchedCount) === 0) {
    throw notFound('Không tìm thấy document này, có thể đã bị xoá. Tải lại danh sách rồi thử lại.');
  }
  return { matchedCount: numberOf(result.matchedCount) ?? 0, modifiedCount: numberOf(result.modifiedCount) ?? 0 };
}

/** Route /documents/delete: xoá document theo _id. */
export async function deleteRoute(body: Body): Promise<DeleteResponse> {
  const record = await connectionFrom(body);
  assertWritable(record);
  const database = requireString(body, 'database', 255);
  const collection = requireString(body, 'collection', 255);
  if (body.id === undefined || body.id === null) throw badRequest('Thiếu _id của document cần xoá');
  const id = toBson(body.id);
  const result = await withDatabase(record, database, (db) =>
    db.collection(collection).deleteOne({ _id: id } as Document));
  if (numberOf(result.deletedCount) === 0) {
    throw notFound('Không tìm thấy document này, có thể đã bị xoá. Tải lại danh sách rồi thử lại.');
  }
  return { deletedCount: numberOf(result.deletedCount) ?? 0 };
}
