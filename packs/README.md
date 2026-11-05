# Knowledge packs

Packs are offline, versioned advisory knowledge. Figures in entries are statutory text with primary-source citations, not household calculations. Each entry states its tax year and editorial reviewed date. Older publications support continuing rules; annual figures cite the applicable annual guidance. Published 2027 figures are identified separately. Review dates describe the source check, not a promise that later law is unchanged.

## Format and adding a pack

Add a pack directory with `manifest.json` and markdown files. The frozen manifest shape is:

```json
{
  "id": "sample-pack",
  "name": "Sample pack",
  "version": "1.0.0",
  "taxYear": 2026,
  "reviewed": "2026-01-01",
  "curator": "Public primary-source review",
  "covers": ["Planning topic"],
  "appliesWhen": {"fact": "income.selfEmployed", "op": "eq", "value": true},
  "suggestWhen": {"fact": "income.w2", "op": "eq", "value": true},
  "whatIf": {"prompt": "What changes if the owner becomes self-employed?"},
  "entries": [{
    "file": "overview.md",
    "title": "Overview",
    "cites": [{"label": "IRS guidance", "url": "https://www.irs.gov/publications/p505"}]
  }]
}
```

Use a unique slug ID and increment the version when editing content. `suggestWhen` is optional. Entries require nonempty titles and absolute HTTP(S) citation URLs. Entry files must be relative markdown paths confined to the pack directory. Their filename stem is the entry ID; stems must be unique within the pack. Every public entry includes `Tax year: 2026`, `Reviewed: YYYY-MM-DD`, and inline source links matching its manifest citations. Verify figures and deadlines against public primary sources before writing them. Run `node --test src/packs/test/engine.test.mjs src/packs/test/content.test.mjs` after adding a pack; extend the public inventory assertion for an intentionally new public ID. Tests are offline and verify structure and editorial metadata; numerical source verification is an editorial check.

## Loading and citations

The API in `src/packs/index.mjs` is synchronous:

```js
import { loadPacks, evaluate, activePacks, packContext, getEntry } from '../src/packs/index.mjs';

const packs = loadPacks(['./packs']);
const facts = { 'income.selfEmployed': true };
const activation = activePacks(packs, facts);
const context = packContext(activation);
const entry = getEntry(packs, 'sample-pack', 'overview');
```

To include an installed private pack, pass its existing `$FATHOM_DATA/packs/your-plans/` directory as another array element. Pass only existing, configured directory strings. A directory containing `manifest.json` is a direct pack; otherwise it is a parent whose immediate subdirectories with manifests are loaded. Missing roots, malformed manifests, duplicate pack IDs, missing or empty entries and paths escaping the pack fail loudly with the relevant path. Empty parent directories and unrelated children without manifests are ignored.

`loadPacks` returns sorted pack objects with manifest fields, a runtime `directory`, and entries augmented with `id` and `body`. `getEntry` returns the loaded entry, including `title`, `body` and `cites`, or `undefined` for a missing pack or entry. A private Your plans pack uses the same format and can be passed directly from the deployment data volume. Never put household data in the public packs or repository.

## Activation

Facts are a flat object of dotted keys and raw JSON values.

`income.w2` means W-2 wages from an outside employer. Wages from the household's own S corporation are represented by `income.sCorp` and do not set `income.w2` to true. Both facts may be true when the household also has outside-employer wages. An S corp household without outside-employer wages is offered W-2 benefits as a suggestion because owner wages and shareholder benefit rules differ.

Rules are `{all:[Rule]}`, `{any:[Rule]}`, `{not:Rule}`, or `{fact, op, value}`. Operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in` and `exists`. Equality compares JSON values without coercion; numeric operators require finite numbers. For `in`, the rule value is an array containing allowed fact values. `exists` has no value and tests own-key presence, including false and null.

Missing value comparisons are unknown, including under `not`. An absent key makes `exists` false. In `all`, a known false dominates; in `any`, a known true dominates. Empty `all` is true and empty `any` is false. `evaluate` returns true only for a known match and throws for malformed rules.

`activePacks` returns every pack as `{pack, status, why}`: a matching `appliesWhen` makes it `active`; otherwise a matching `suggestWhen` makes it `suggested`; otherwise it is `available`. Unknown activation does not suppress a known suggestion. Reasons describe the facts that establish the match. Suggestions are editorial exploration triggers, not tax eligibility or tax-law cutoffs. In particular, the charitable pack's AGI suggestion threshold is a product choice. The stored what-if prompt starts a later conversation; this library does not generate an answer or persist manual toggles.

`packContext` returns deterministic JSON with `{version: 1, packs: [...]}`. It sorts packs, entries, citations and object keys, includes active public and private markdown with manifest metadata, and excludes runtime paths, activation reasons and household facts. Unchanged knowledge produces identical bytes regardless of input ordering. A content or manifest version change changes the context. No embeddings or network access are required at runtime.
