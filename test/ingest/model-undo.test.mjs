import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, upload, approve, transactions } from '../helpers/model-cutover.mjs';
import { recipe } from '../helpers/model-import.mjs';
import { undoAction } from '../../src/actions/receipts.mjs';

test('shared Undo restores the previous same-file interpretation and retains source and spend', async () => {
  const x = await setup();
  try {
    const first = await upload(x, transactions()); await approve(x, first);
    const before = x.db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const layout = recipe(); layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
    const next = await upload(x, transactions(), layout, { reinterpret: true });
    const approved = await approve(x, next);
    await undoAction(x.ctx, approved.receipt.id, 'write:imports');
    assert.deepEqual(x.db.prepare('SELECT * FROM transactions ORDER BY id').all(), before);
    assert.equal(x.db.prepare('SELECT count(*) n FROM files').get().n, 1);
    assert.equal(x.db.prepare('SELECT count(*) n FROM import_model_spend').get().n, 2);
    assert.equal(x.db.prepare('SELECT status FROM import_batches ORDER BY rowid DESC LIMIT 1').get().status, 'undone');
  } finally { x.close(); }
});

test('Undo refuses another actor, missing scope and changed after-state without partial effects', async () => {
  for (const refusal of ['actor','scope','stale']) {
    const x = await setup();
    try {
      const r = await upload(x, transactions()), approved = await approve(x,r);
      let ctx = x.ctx;
      if (refusal === 'actor') ctx = { ...ctx, actorId: 'another-actor' };
      if (refusal === 'scope') ctx = { ...ctx, scopes: [] };
      if (refusal === 'stale') x.db.prepare('UPDATE transactions SET amount=-99 WHERE id=(SELECT min(id) FROM transactions)').run();
      const before = x.db.prepare('SELECT * FROM transactions ORDER BY id').all();
      await assert.rejects(undoAction(ctx, approved.receipt.id, 'write:imports'), e => e.code === (refusal === 'stale' ? 'conflict' : 'forbidden'));
      assert.deepEqual(x.db.prepare('SELECT * FROM transactions ORDER BY id').all(), before);
      assert.equal(x.db.prepare('SELECT status FROM import_batches').get().status, 'committed');
    } finally { x.close(); }
  }
});
test('Undo first approval makes the layout require approval again', async () => {
  const x = await setup();
  try {
    const r = await upload(x, transactions()), approved = await approve(x,r);
    await undoAction(x.ctx, approved.receipt.id, 'write:imports');
    assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
    const next = await upload(x, transactions('-15.00'));
    assert.equal(next.status, 'needs_confirmation');
  } finally { x.close(); }
});


test('Undo survives the real category guessing job but refuses a later owner correction', async () => {
  const { guessCategories } = await import('../../src/categories/guess.mjs');
  const { setTransactionCategory } = await import('../../src/categories/store.mjs');
  const { JEV_MODEL } = await import('../../src/categories/jev.mjs');
  for (const confidence of [0.85,0.95]) for (const ownerChange of [false,true]) {
    const x = await setup();
    try {
      const approved = await approve(x,await upload(x,transactions()));
      x.db.prepare("INSERT INTO category_source_rules VALUES ('aggregator','Groceries','household',?)").run(x.ctx.now);
      x.db.prepare("INSERT INTO category_source_rules VALUES ('aggregator','Business','business',?)").run(x.ctx.now);
      const guessed = await guessCategories(x.db,{isOn:()=>true,model:JEV_MODEL,choose:async questions=>questions.map(()=>({choice:'Groceries',confidence,probabilities:{Groceries:confidence,Business:1-confidence}}))},{now:x.ctx.now});
      assert.equal(guessed.stopped,undefined);
      assert.equal(x.db.prepare('SELECT count(*) n FROM transaction_category_guesses').get().n,2);
      assert.equal(x.db.prepare('SELECT count(*) n FROM confirm_auto').get().n,confidence>=0.9 ? 2 : 0);
      if (ownerChange) {
        setTransactionCategory(x.db,x.db.prepare('SELECT min(id) id FROM transactions').get().id,'Business',{now:x.ctx.now});
        await assert.rejects(undoAction(x.ctx,approved.receipt.id,'write:imports'), e=>e.code==='conflict');
        assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n,2);
      } else {
        await undoAction(x.ctx,approved.receipt.id,'write:imports');
        assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n,0);
        assert.equal(x.db.prepare('SELECT count(*) n FROM transaction_category_guesses').get().n,0);
        assert.equal(x.db.prepare("SELECT count(*) n FROM confirm_items WHERE kind='transaction_category'").get().n,0);
      }
    } finally { x.close(); }
  }
});


test('grouped reinterpret Undo retains the active file status and permits another reinterpret', async () => {
  const { importProposedRows } = await import('../helpers/import-proposal-fixture.mjs');
  const { retryFile } = await import('../../src/ingest/pipeline.mjs');
  const x = await setup();
  try {
    x.ctx.scopes.push('write:facts');
    const rows = [{ target:'document',docType:'w2',fields:{taxYear:2031,employerName:'Synthetic employer',wages:500} }];
    await importProposedRows(x,rows);
    const second = await importProposedRows(x,rows,{reinterpret:true});
    assert.deepEqual(second.receipt.scopes,['write:facts','write:imports']);
    await undoAction(x.ctx,second.receipt.id,'write:imports');
    assert.equal(x.db.prepare('SELECT status FROM files WHERE id=?').get(second.fileId).status,'imported');
    const proposal = JSON.parse(x.db.prepare('SELECT proposal FROM import_proposals ORDER BY rowid DESC LIMIT 1').get().proposal);
    const staged = await retryFile(x.db,second.fileId,{...x.opts,scopes:x.ctx.scopes,mode:'reinterpret',fake:[{text:JSON.stringify({rows:proposal.rows,coverage:proposal.coverage,completeness:proposal.completeness})}]});
    assert.equal(staged.status,'needs_confirmation');
  } finally { x.close(); }
});
