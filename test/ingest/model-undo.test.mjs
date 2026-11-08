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
  for (const ownerChange of [false,true]) {
    const x = await setup();
    try {
      const approved = await approve(x,await upload(x,transactions()));
      x.db.prepare("INSERT INTO category_source_rules VALUES ('aggregator','Groceries','household',?)").run(x.ctx.now);
      x.db.prepare("INSERT INTO category_source_rules VALUES ('aggregator','Business','business',?)").run(x.ctx.now);
      const guessed = await guessCategories(x.db,{isOn:()=>true,model:'synthetic-category-provider',choose:async questions=>questions.map(()=>({choice:'Groceries',confidence:0.8,probabilities:{Groceries:0.8,Business:0.2}}))},{now:x.ctx.now});
      assert.equal(guessed.stopped,undefined);
      assert.equal(x.db.prepare('SELECT count(*) n FROM transaction_category_guesses').get().n,2);
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
