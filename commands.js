// Commands describe a single reversible mutation. Each entry has apply/revert
// and a coalesceKey used by history to merge rapid edits into one undo step.

export const COMMANDS = {
  ADD_SCAN: {
    apply: (s, p) => {
      s.scans = [...s.scans, p.to];
    },
    revert: (s, p) => {
      s.scans = s.scans.filter((x) => !(x.isbn === p.to.isbn && x.t === p.to.t));
    },
    coalesceKey: (p) => `${p.to.isbn}:${p.to.t}`,
  },
  REMOVE_SCAN: {
    apply: (s, p) => {
      s.scans = s.scans.filter((x) => !(x.isbn === p.from.isbn && x.t === p.from.t));
    },
    revert: (s, p) => {
      const next = s.scans.slice();
      const i = Math.min(p.from.index, next.length);
      next.splice(i, 0, { isbn: p.from.isbn, t: p.from.t });
      s.scans = next;
    },
    coalesceKey: (p) => `${p.from.isbn}:${p.from.t}`,
  },
};

export const makeCommand = (type, payload) => ({ type, payload });

export const coalesceKeyOf = (cmd) =>
  `${cmd.type}:${COMMANDS[cmd.type].coalesceKey(cmd.payload)}`;

export const isNoOp = (cmd) => {
  const { from, to } = cmd.payload;
  if (from == null && to == null) return true;
  if (from == null || to == null) return false;
  return JSON.stringify(from) === JSON.stringify(to);
};
