// Admission is shared by every scheduler in an instance. Waiting households take turns;
// a household cannot occupy both handler slots, even with several different jobs queued.
export function createJobDispatcher() {
  const waiting = new Map();
  const active = new Set();
  const lastTurn = new Map();
  let turn = 0;

  function pump() {
    while (active.size < 2) {
      const id = [...waiting.keys()].filter(key => !active.has(key))
        .sort((a, b) => (lastTurn.get(a) ?? 0) - (lastTurn.get(b) ?? 0))[0];
      if (id === undefined) return;
      const queue = waiting.get(id);
      const item = queue.shift();
      if (!queue.length) waiting.delete(id);
      active.add(id);
      lastTurn.set(id, ++turn);
      let result;
      try { result = item.work(); } catch (error) { result = Promise.reject(error); }
      Promise.resolve(result).then(
        value => { active.delete(id); pump(); item.resolve(value); },
        error => { active.delete(id); pump(); item.reject(error); },
      );
    }
  }

  return Object.freeze({
    run(householdId, work) {
      return new Promise((resolve, reject) => {
        const queue = waiting.get(householdId) ?? [];
        queue.push({ work, resolve, reject });
        waiting.set(householdId, queue);
        pump();
      });
    },
  });
}
