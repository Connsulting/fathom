-- 003 ingest recipients: who a withholding row belongs to (owner, spouse or unknown), set from the
-- employer_recipient and document_recipient confirm answers. It is also the last segment of the
-- row's wh: source slot, so paystub detail is summarized only by the same person's W-2.
-- Nullable: workbook tax payments and rows stored before this migration carry no recipient.
ALTER TABLE tax_payments ADD COLUMN recipient TEXT;
