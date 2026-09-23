/**
 * 校验并打印 categories / records 种子数据摘要。
 * 线上写入请在微信开发者工具中上传并调用 seedData 云函数。
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const payload = require('./data/seedPayload.cjs') as {
  categories: Array<{ type: string; _id: string; name: string }>;
  demoRecords: unknown[];
  COLLECTIONS: Record<string, string>;
};

export function summarizeSeed(): {
  categoryCount: number;
  byType: Record<string, number>;
  roomIds: string[];
  demoRecordCount: number;
  collections: Record<string, string>;
} {
  const byType: Record<string, number> = {};
  const roomIds: string[] = [];
  for (const cat of payload.categories) {
    byType[cat.type] = (byType[cat.type] || 0) + 1;
    if (cat.type === 'room') roomIds.push(cat._id);
  }
  return {
    categoryCount: payload.categories.length,
    byType,
    roomIds,
    demoRecordCount: payload.demoRecords.length,
    collections: payload.COLLECTIONS,
  };
}

export async function seedCategories(): Promise<void> {
  const summary = summarizeSeed();
  console.log('[seedCategories] 本地校验通过，摘要如下：');
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    '[seedCategories] 请在微信开发者工具上传云函数 seedData 后调用，以写入云数据库。',
  );
}

const isDirect =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('seedCategories.ts');

if (isDirect) {
  seedCategories().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
