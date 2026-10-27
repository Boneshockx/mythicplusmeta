import 'dotenv/config';
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || ''
});

try {
  const schema = fs.readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
    await connection.query(statement);
  }
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weekly_leaderboard_runs' AND COLUMN_NAME = 'connected_realm_id'`
  );
  if (!columns.length) {
    await connection.query('ALTER TABLE weekly_leaderboard_runs ADD COLUMN connected_realm_id INT UNSIGNED NOT NULL DEFAULT 0 AFTER region');
  }
  const [indexes] = await connection.query('SHOW INDEX FROM weekly_leaderboard_runs');
  const uniqueIndex = indexes.filter((index) => index.Key_name === 'unique_weekly_leaderboard_entry').sort((a, b) => a.Seq_in_index - b.Seq_in_index);
  const expectedColumns = ['period_id', 'region', 'connected_realm_id', 'dungeon_id', 'ranking'];
  if (uniqueIndex.map((index) => index.Column_name).join(',') !== expectedColumns.join(',')) {
    if (uniqueIndex.length) await connection.query('ALTER TABLE weekly_leaderboard_runs DROP INDEX unique_weekly_leaderboard_entry');
    await connection.query('ALTER TABLE weekly_leaderboard_runs ADD UNIQUE KEY unique_weekly_leaderboard_entry (period_id, region, connected_realm_id, dungeon_id, ranking)');
  }
  console.log('Database schema applied.');
} finally {
  await connection.end();
}
