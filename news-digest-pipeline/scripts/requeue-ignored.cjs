const Database = require('better-sqlite3');

const db = new Database('./data/news-digest.db');

const rows = db.prepare(`
  SELECT id, title
  FROM articles
  WHERE status = 'ignored'
    AND digest_id IS NULL
  ORDER BY updated_at ASC, created_at ASC
`).all();

if (rows.length === 0) {
  console.log('No ignored articles to requeue');
  db.close();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE articles
  SET status = 'new',
      commentary = NULL,
      updated_at = datetime('now')
  WHERE id = ?
`);

const requeue = db.transaction(() => {
  for (const row of rows) update.run(row.id);
});

requeue();

console.log(`Requeued ${rows.length} ignored articles`);
for (const row of rows) console.log(`- ${row.title}`);

db.close();
