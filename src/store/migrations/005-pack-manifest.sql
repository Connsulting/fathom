-- 005 pack manifest: a packs_state row def may carry `manifest`, the id of the repo pack manifest
-- the row stands for, so the MCP pack tools can apply the owner's toggles. Rows without a tag link
-- by their own id (real stores use manifest ids as row ids). This tags the demo store's seeded rows
-- only; a real store is left alone. Idempotent: a row that already has a tag is skipped.
UPDATE packs_state
SET def = json_set(def, '$.manifest', CASE id
  WHEN 'scorp' THEN 's-corp-owner'
  WHEN 'selfemp' THEN 'self-employed-partnership'
  WHEN 'w2' THEN 'w2-benefits'
  WHEN 'virginia' THEN 'virginia-resident'
  WHEN 'kids' THEN 'kids-dependents'
  WHEN 'retire' THEN 'advanced-retirement'
  WHEN 'giving' THEN 'charitable-giving'
END)
WHERE id IN ('scorp', 'selfemp', 'w2', 'virginia', 'kids', 'retire', 'giving')
  AND json_extract(def, '$.manifest') IS NULL
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'mode' AND json_extract(value, '$') = 'demo');
