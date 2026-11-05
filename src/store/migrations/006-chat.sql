-- Item 6: chat over the data and live knowledge packs. Runs after 005-pack-manifest, which tags
-- the demo pack rows with their repository manifest id.

-- Answer provenance (JSON or NULL): engine, model, tools with args, figure keys, pack ids,
-- bound literals, grounding result and cost. Never prompt text.
ALTER TABLE messages ADD COLUMN provenance TEXT;

-- Demo stores only: keep the demo display name of each manifest-tagged demo pack (005) as a label
-- override, so the live pack view shows the demo name over the manifest's. Real stores are never
-- touched; a row that already has a label keeps it.
UPDATE packs_state
SET def = json_set(def, '$.label', json_extract(def, '$.name'))
WHERE id IN ('scorp', 'selfemp', 'w2', 'virginia', 'kids', 'retire', 'giving')
  AND json_valid(def)
  AND json_extract(def, '$.manifest') IS NOT NULL
  AND json_extract(def, '$.label') IS NULL
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'mode' AND json_valid(value) AND json_extract(value, '$') = 'demo');

-- Demo stores only: the demo seed now carries the synthetic fact income.agiEstimate so the giving
-- pack reads suggested. Add it to an older demo store when absent, keeping any existing value.
-- The seed file row is referenced only when it exists. Real stores get no fact.
INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
SELECT 'income.agiEstimate', '380000', 'you',
  COALESCE((SELECT as_of FROM facts WHERE src = 'you' AND as_of IS NOT NULL LIMIT 1), date('now')),
  1, (SELECT id FROM files WHERE id = 'demo-seed'), 'demo-seed', 'facts:income.agiEstimate',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM facts WHERE key = 'income.agiEstimate')
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'mode' AND json_valid(value) AND json_extract(value, '$') = 'demo');
