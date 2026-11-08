INSERT INTO platform_settings (key, value, updated_at)
VALUES ('multi_household_enabled', 'true', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
