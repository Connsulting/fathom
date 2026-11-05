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
