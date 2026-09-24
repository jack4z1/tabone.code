// Silknet — shared constants.
//
// Deliberately its own module with no dependencies: the Phase-1 passive probe is
// injected into every matching page load, so everything it imports is a cost paid
// on ordinary browsing. Keeping the namespace here (rather than in messaging.ts,
// which pulls in the full validator set) is what keeps probe.js small.

/** Message namespace. Every cross-context envelope is stamped with this. */
export const NS = 'silknet/v0.1' as const;
