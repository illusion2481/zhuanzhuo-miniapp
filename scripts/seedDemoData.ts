/**
 * 演示数据摘要 — 实际写入由云函数 seedData（includeDemoRecords）完成
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const payload = require('./data/seedPayload.cjs') as {
  demoRecords: Array<{ _id: string; status: string }>;
};

export async function seedDemoData(): Promise<void> {
  console.log('[seedDemoData] 演示预约记录数:', payload.demoRecords.length);
  payload.demoRecords.forEach((r) => {
    console.log(`  - ${r._id} (${r.status})`);
  });
  console.log('[seedDemoData] 请调用云函数 seedData 写入 records 集合。');
}

const isDirect =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('seedDemoData.ts');

if (isDirect) {
  seedDemoData().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
