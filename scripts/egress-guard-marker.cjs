// Shared marker for the offline egress guards and their counter.
const GUARD_MARKER = "v2-eval-guard: blocked egress";

const isGuardLine = (line) => String(line).includes(GUARD_MARKER);

module.exports = { GUARD_MARKER, isGuardLine };
