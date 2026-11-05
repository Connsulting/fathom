-- Item 6: chat over the data and live knowledge packs.

-- Answer provenance (JSON or NULL): engine, model, tools with args, figure keys, pack ids,
-- bound literals, grounding result and cost. Never prompt text.
ALTER TABLE messages ADD COLUMN provenance TEXT;

-- Demo stores only: tag the seven demo packs that have a repository manifest with that manifest
-- id, and keep their demo display name as a label override, so refreshPackState rewrites them in
-- place (ids, overrides, recs and conversation keys stay stable). Real stores are never tagged.
UPDATE packs_state
SET def = json_set(def,
  '$.manifest', CASE id
    WHEN 'scorp' THEN 's-corp-owner'
    WHEN 'selfemp' THEN 'self-employed-partnership'
    WHEN 'w2' THEN 'w2-benefits'
    WHEN 'virginia' THEN 'virginia-resident'
    WHEN 'kids' THEN 'kids-dependents'
    WHEN 'retire' THEN 'advanced-retirement'
    WHEN 'giving' THEN 'charitable-giving'
  END,
  '$.label', json_extract(def, '$.name'))
WHERE id IN ('scorp', 'selfemp', 'w2', 'virginia', 'kids', 'retire', 'giving')
  AND json_valid(def)
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
