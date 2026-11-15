/**
 * Detector prisma (chỉ provider "mongodb"; provider khác bị bỏ qua có cảnh báo).
 * - model X → collection X; @@map("y") → collection y (khai báo).
 * - @id → pk. Field kiểu vô hướng là cột; kiểu là model khác là quan hệ.
 * - @relation(fields: [a], ...) → belongsTo trên field a. Kiểu model không kèm fields → hasMany (mảng) hoặc hasOne.
 * - @@index([...]) / @@unique([...]) → index.
 */
import { collectionOf, type Detector, type Draft, emptyDraft, fieldOf, indexOf, insideOf } from './common.ts';

const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);
const FIELD = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/;

type Model = { name: string; collection: string; fields: ReturnType<typeof fieldOf>[]; indexes: ReturnType<typeof indexOf>[]; relations: Array<{ target: string; field: string | null; kind: 'belongsTo' | 'hasMany' | 'hasOne' }> };

function listOf(text: string): string[] {
  return text.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter((item) => item !== '');
}

function modelOf(name: string, body: string): Model {
  const map = /@@map\(\s*"([^"]+)"/.exec(body)?.[1];
  const model: Model = { name, collection: map ?? name, fields: [], indexes: [], relations: [] };
  for (const raw of body.split('\n').map((line) => line.trim())) {
    if (raw === '' || raw.startsWith('//')) continue;
    if (raw.startsWith('@@')) {
      const index = /@@(index|unique)\(\s*\[([^\]]*)\]/.exec(raw);
      if (index) model.indexes.push(indexOf(listOf(index[2] ?? ''), { unique: index[1] === 'unique' }));
      continue;
    }
    const field = FIELD.exec(raw);
    if (!field) continue;
    const [, fieldName = '', type = 'unknown', array, optional, rest = ''] = field;
    const pk = /@id\b/.test(rest);
    if (SCALARS.has(type)) {
      model.fields.push(fieldOf(fieldName, type, { array: array !== undefined, required: optional === undefined, pk }));
      continue;
    }
    const keys = /fields\s*:\s*\[([^\]]*)\]/.exec(rest)?.[1];
    model.fields.push(fieldOf(fieldName, type, { array: array !== undefined, required: optional === undefined }));
    if (keys !== undefined) {
      model.relations.push({ target: type, field: listOf(keys)[0] ?? null, kind: 'belongsTo' });
    } else {
      model.relations.push({ target: type, field: fieldName, kind: array !== undefined ? 'hasMany' : 'hasOne' });
    }
  }
  return model;
}

export const prismaDetector: Detector = {
  id: 'prisma',
  detect(files) {
    const draft: Draft = emptyDraft();
    const models: Model[] = [];
    for (const file of files) {
      if (!file.rel.endsWith('.prisma')) continue;
      const datasource = /datasource\s+\w+\s*\{/.exec(file.text);
      const provider = datasource ? /provider\s*=\s*"(\w+)"/.exec(insideOf(file.text, datasource.index + datasource[0].length - 1))?.[1] : undefined;
      if (provider !== 'mongodb') {
        draft.warnings.push(`prisma: only the "mongodb" provider is supported, skipped ${file.rel}`);
        continue;
      }
      for (const match of file.text.matchAll(/model\s+(\w+)\s*\{/g)) {
        const body = insideOf(file.text, (match.index ?? 0) + match[0].length - 1);
        models.push(modelOf(match[1] as string, body));
      }
    }
    const collectionOfModel = new Map(models.map((m) => [m.name, m.collection]));
    for (const model of models) {
      draft.collections.push(collectionOf({
        name: model.collection,
        model: model.name,
        orm: 'prisma',
        confidence: 'declared',
        fields: model.fields,
        indexes: model.indexes,
      }));
      for (const relation of model.relations) {
        draft.relations.push({
          from: model.collection,
          to: collectionOfModel.get(relation.target) ?? relation.target,
          field: relation.field,
          kind: relation.kind,
          confidence: 'declared',
        });
      }
    }
    return draft;
  },
};
