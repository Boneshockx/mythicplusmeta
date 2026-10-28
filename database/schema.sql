CREATE DATABASE IF NOT EXISTS mythicplusmeta CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mythicplusmeta;

CREATE TABLE IF NOT EXISTS mythic_plus_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_run_id VARCHAR(100) NOT NULL,
  region VARCHAR(8) NOT NULL,
  season VARCHAR(64) NOT NULL,
  dungeon VARCHAR(160) NOT NULL,
  level SMALLINT UNSIGNED NULL,
  completed_at DATETIME NULL,
  score DECIMAL(9,2) NULL,
  roster JSON NOT NULL,
  payload JSON NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_source_run (source_run_id, region, season),
  KEY idx_season_region_level (season, region, level),
  KEY idx_dungeon (dungeon)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  status VARCHAR(20) NOT NULL,
  regions JSON NOT NULL,
  imported_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_started_at (started_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS weekly_periods (
  period_id INT UNSIGNED NOT NULL,
  region VARCHAR(8) NOT NULL,
  season_id INT UNSIGNED NOT NULL,
  season_name VARCHAR(80) NOT NULL,
  start_timestamp BIGINT UNSIGNED NOT NULL,
  end_timestamp BIGINT UNSIGNED NOT NULL,
  imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (period_id, region),
  KEY idx_weekly_season (season_id, region, start_timestamp)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mythic_plus_dungeon_timers (
  season_id INT UNSIGNED NOT NULL,
  expansion_id SMALLINT UNSIGNED NOT NULL,
  season_slug VARCHAR(100) NOT NULL,
  dungeon_id INT UNSIGNED NULL,
  dungeon_slug VARCHAR(160) NOT NULL,
  dungeon_name VARCHAR(160) NOT NULL,
  time_limit_ms INT UNSIGNED NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (season_id, dungeon_slug),
  KEY idx_dungeon_timer_slug (season_slug, dungeon_slug),
  KEY idx_dungeon_timer_name (season_id, dungeon_name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS weekly_leaderboard_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_id INT UNSIGNED NOT NULL,
  region VARCHAR(8) NOT NULL,
  connected_realm_id INT UNSIGNED NOT NULL DEFAULT 0,
  season_id INT UNSIGNED NOT NULL,
  dungeon_id INT UNSIGNED NOT NULL,
  dungeon VARCHAR(160) NOT NULL,
  ranking INT UNSIGNED NOT NULL,
  level SMALLINT UNSIGNED NOT NULL,
  score DECIMAL(10,2) NULL,
  completed_at DATETIME NULL,
  roster JSON NOT NULL,
  payload JSON NOT NULL,
  imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY unique_weekly_leaderboard_entry (period_id, region, connected_realm_id, dungeon_id, ranking),
  KEY idx_weekly_period_region (period_id, region, season_id),
  KEY idx_weekly_dungeon (period_id, region, dungeon_id, level)
) ENGINE=InnoDB;
