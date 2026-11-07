import { resolve, basename, dirname } from 'node:path';
import { openServedStore } from '../src/platform/ready.mjs';
import { DB_FILE } from '../src/store/db.mjs';
import { categoryCoverage } from '../src/categories/store.mjs';

const path=process.argv[2];
if(!path) { console.error('Usage: node scripts/category-coverage.mjs <store-directory-or-file>'); process.exitCode=2; }
else {
  let store;
  try {
    const absolute=resolve(path);
    store=openServedStore({dataDir:basename(absolute)===DB_FILE ? dirname(absolute) : absolute});
    console.log(JSON.stringify(categoryCoverage(store.db)));
  } catch(error) { console.error(error?.code ?? 'category_coverage_failed'); process.exitCode=1; }
  finally { store?.db.close(); store?.platform.close(); }
}
