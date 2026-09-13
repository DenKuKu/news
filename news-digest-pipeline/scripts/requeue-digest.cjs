const Database = require('better-sqlite3');

const digestId = process.argv[2];

if (!digestId) {
  console.error('Usage: node scripts/requeue-digest.cjs <digest-id>');
  process.exit(1);
}

const db = new Database('./data/news-digest.db');

const rows = db.prepare(`
  SELECT id, title
  FROM articles
  WHERE digest_id = ?
  ORDER BY created_at ASC
`).all(digestId);

if (rows.length === 0) {
  console.error(`No articles found for digest ${digestId}`);
  db.close();
  process.exit(1);
}

const update = db.prepare(`
  UPDATE articles
  SET status = 'new',
      digest_id = NULL,
      commentary = NULL,
      updated_at = datetime('now')
  WHERE id = ?
`);

const requeue = db.transaction(() => {
  for (const row of rows) update.run(row.id);
});

requeue();

console.log(`Requeued ${rows.length} articles from digest ${digestId}`);
for (const row of rows) console.log(`- ${row.title}`);

db.close();
