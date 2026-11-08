ALTER TABLE import_proposals ADD COLUMN review_state TEXT;
ALTER TABLE column_mappings ADD COLUMN header_signature TEXT;
CREATE INDEX column_mappings_headers ON column_mappings(header_signature);
