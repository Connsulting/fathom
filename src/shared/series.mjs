// Array iteration with asynchronous callbacks, one item at a time and in order, so storage calls
// keep the order the synchronous loops gave them. Each helper takes the collection first and calls
// fn(item, index, collection) like its Array counterpart; forEachSeries also walks Maps and Sets
// with their own forEach argument order.

const items = collection => (Array.isArray(collection) ? collection : Array.from(collection));

export async function mapSeries(collection, fn) {
  const list = items(collection), out = [];
  for (let i = 0; i < list.length; i++) out.push(await fn(list[i], i, collection));
  return out;
}

export async function flatMapSeries(collection, fn) {
  return (await mapSeries(collection, fn)).flat();
}

export async function filterSeries(collection, fn) {
  const list = items(collection), out = [];
  for (let i = 0; i < list.length; i++) if (await fn(list[i], i, collection)) out.push(list[i]);
  return out;
}

export async function forEachSeries(collection, fn) {
  if (collection instanceof Map) { for (const [key, value] of collection) await fn(value, key, collection); return; }
  if (collection instanceof Set) { for (const value of collection) await fn(value, value, collection); return; }
  const list = items(collection);
  for (let i = 0; i < list.length; i++) await fn(list[i], i, collection);
}

export async function someSeries(collection, fn) {
  const list = items(collection);
  for (let i = 0; i < list.length; i++) if (await fn(list[i], i, collection)) return true;
  return false;
}

export async function everySeries(collection, fn) {
  const list = items(collection);
  for (let i = 0; i < list.length; i++) if (!await fn(list[i], i, collection)) return false;
  return true;
}

export async function findSeries(collection, fn) {
  const list = items(collection);
  for (let i = 0; i < list.length; i++) if (await fn(list[i], i, collection)) return list[i];
  return undefined;
}

export async function findIndexSeries(collection, fn) {
  const list = items(collection);
  for (let i = 0; i < list.length; i++) if (await fn(list[i], i, collection)) return i;
  return -1;
}

export async function reduceSeries(collection, fn, ...initial) {
  const list = items(collection);
  if (!initial.length && !list.length) throw new TypeError('Reduce of empty array with no initial value');
  let i = initial.length ? 0 : 1;
  let acc = initial.length ? initial[0] : list[0];
  for (; i < list.length; i++) acc = await fn(acc, list[i], i, collection);
  return acc;
}
