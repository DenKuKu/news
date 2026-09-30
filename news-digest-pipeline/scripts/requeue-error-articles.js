import config from '../src/config.js';
import { initDb } from '../src/db/index.js';

const db = initDb(config.dbPath);

const result = db.prepare(`
  UPDATE articles
  SET status = 'new',
      updated_at = CURRENT_TIMESTAMP
  WHERE digest_id IS NULL
    AND status = 'error'
`).run();

console.log(`requeued: ${result.changes}`);
