/**
 * Detector typeorm (chỉ file có import từ 'typeorm'):
 * - @Entity('x') → collection x (khai báo); @Entity() → snake của tên lớp (suy đoán).
 * - @ObjectIdColumn / @PrimaryColumn → pk. @Column({type}) → kiểu; không có thì lấy kiểu TypeScript.
 * - @ManyToOne/@OneToOne/@OneToMany/@ManyToMany(() => X) → quan hệ khai báo.
 * Giới hạn: decorator phải nằm trên một dòng và property ngay dòng sau.
 */
import type { SchemaField } from '../../shared/api.ts';
import { collectionOf, type Detector, type Draft, emptyDraft, fieldOf, insideOf, snakeOf } from './common.ts';

const ENTITY = /@Entity\(\s*(?:['"]([^'"]+)['"])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g;
const DECORATOR = /^@(\w+)\s*\((.*)\)\s*$/;
const PROPERTY = /^(\w+)\s*[?!]?\s*:\s*([^;=]+)/;
const RELATIONS: Record<string, 'belongsTo' | 'hasOne' | 'hasMany' | 'belongsToMany'> = {
  ManyToOne: 'belongsTo',
  OneToOne: 'hasOne',
  OneToMany: 'hasMany',
  ManyToMany: 'belongsToMany',
};
const COLUMNS = new Set(['Column', 'CreateDateColumn', 'UpdateDateColumn']);
const PKS = new Set(['ObjectIdColumn', 'PrimaryColumn', 'PrimaryGeneratedColumn', 'ObjectId']);

type Pending = { from: string; target: string; kind: 'belongsTo' | 'hasOne' | 'hasMany' | 'belongsToMany'; field: string };

function fieldsOf(body: string): { fields: SchemaField[]; relations: Array<{ field: string; target: string; kind: Pending['kind'] }> } {
  const fields: SchemaField[] = [];
  const relations: Array<{ field: string; target: string; kind: Pending['kind'] }> = [];
  const lines = body.split('\n').map((line) => line.trim());
  lines.forEach((line, index) => {
    const decorator = DECORATOR.exec(line);
    if (!decorator) return;
    const next = lines.slice(index + 1).find((candidate) => !candidate.startsWith('@') && candidate !== '') ?? '';
    const property = PROPERTY.exec(next);
    if (!property) return;
    const [, name = '', tsType = 'mixed'] = property;
    const kind = decorator[1] as string;
    const args = decorator[2] ?? '';
    const type = tsType.trim();
    if (PKS.has(kind)) {
      fields.push(fieldOf(name, kind === 'ObjectIdColumn' ? 'ObjectId' : type, { pk: true }));
    } else if (COLUMNS.has(kind)) {
      const declared = /type\s*:\s*['"](\w+)['"]/.exec(args)?.[1];
      fields.push(fieldOf(name, declared ?? type, { required: !/nullable\s*:\s*true/.test(args) }));
    } else if (RELATIONS[kind]) {
      const target = /=>\s*(\w+)/.exec(args)?.[1] ?? type;
      fields.push(fieldOf(name, target));
      relations.push({ field: name, target, kind: RELATIONS[kind] as Pending['kind'] });
    }
  });
  return { fields, relations };
}

export const typeormDetector: Detector = {
  id: 'typeorm',
  detect(files) {
    const draft: Draft = emptyDraft();
    const classNames = new Map<string, string>();
    const pending: Pending[] = [];
    for (const file of files) {
      if (!/from\s+['"]typeorm['"]/.test(file.text)) continue;
      for (const match of file.text.matchAll(ENTITY)) {
        const table = match[1] ?? null;
        const className = match[2] as string;
        const open = file.text.indexOf('{', (match.index ?? 0) + match[0].length);
        const body = open === -1 ? '' : insideOf(file.text, open);
        const name = table ?? snakeOf(className);
        classNames.set(className, name);
        const { fields, relations } = fieldsOf(body);
        draft.collections.push(collectionOf({
          name,
          model: className,
          file: file.rel,
          orm: 'typeorm',
          confidence: table ? 'declared' : 'inferred',
          fields,
        }));
        for (const relation of relations) pending.push({ from: name, ...relation });
      }
    }
    for (const item of pending) {
      draft.relations.push({
        from: item.from,
        to: classNames.get(item.target) ?? snakeOf(item.target),
        field: item.field,
        kind: item.kind,
        confidence: 'declared',
      });
    }
    return draft;
  },
};
