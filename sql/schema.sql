-- Optional: only needed if you use SqlLogger
-- This schema works for MySQL/MariaDB. For Postgres/SQLite, adjust types as noted.

CREATE TABLE IF NOT EXISTS request_forward_log (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,  -- Postgres: BIGSERIAL; SQLite: INTEGER PRIMARY KEY AUTOINCREMENT
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, -- Postgres: TIMESTAMPTZ; SQLite: TEXT DEFAULT CURRENT_TIMESTAMP
    source_label    VARCHAR(64)  NULL,
    method          VARCHAR(10)  NOT NULL,
    target_url      VARCHAR(2048) NOT NULL,                      -- Postgres/SQLite: TEXT
    final_url       VARCHAR(2048) NOT NULL,                      -- Postgres/SQLite: TEXT
    request_headers MEDIUMTEXT NULL,                             -- Postgres/SQLite: TEXT
    request_body    MEDIUMTEXT NULL,                             -- Postgres/SQLite: TEXT
    response_status SMALLINT NULL,
    response_headers MEDIUMTEXT NULL,
    response_body   MEDIUMTEXT NULL,
    attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,         -- Postgres: SMALLINT; SQLite: INTEGER
    duration_ms     INT UNSIGNED NULL,                           -- Postgres/SQLite: INTEGER
    ok              TINYINT(1) NOT NULL DEFAULT 0,               -- Postgres: BOOLEAN; SQLite: INTEGER
    error_message   TEXT NULL,
    client_ip       VARCHAR(45) NULL,
    INDEX idx_created (created_at),
    INDEX idx_source  (source_label),
    INDEX idx_status  (response_status),
    INDEX idx_ok      (ok)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
