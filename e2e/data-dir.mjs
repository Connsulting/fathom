// The one place that names the e2e data directories. Each is a top-level `.e2e-data*` directory in
// the checkout (gitignored as .e2e-data*/); serve.mjs refuses any other name before it wipes anything.
// No imports beyond node:path, so the Playwright config, the servers and the specs can all load it.

import { resolve } from 'node:path';

export const DATA_ROOT = '.e2e-data';

// The directory name for a named fixture: dataName('jan') is '.e2e-data-jan'; no suffix is the main one.
export const dataName = (suffix = '') => (suffix ? `${DATA_ROOT}-${suffix}` : DATA_ROOT);

// The main demo server's data directory name as given (E2E_DATA, else the default), and resolved.
export const mainDataName = () => process.env.E2E_DATA || DATA_ROOT;
export const mainDataDir = () => resolve(mainDataName());

// A named fixture's directory, resolved from the working directory (the repository root).
export const dataDir = (suffix) => resolve(dataName(suffix));
