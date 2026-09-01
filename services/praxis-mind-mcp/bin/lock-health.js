#!/usr/bin/env node
/**
 * Read-only readout of the optimistic-lock health gauge. Never writes.
 */
const { gauge, formatGauge } = require('../lib/lock-health');

const HELP = `praxis-mind optimistic-lock health

Usage:
  lock-health [--tool NAME] [--hours N] [--json]

Defaults to nexus_task_update over the last 24 hours.

  contended     writes that hit a guard mismatch at least once
  auto-resolved contended writes the retry loop landed (or found already done)
  unresolved    writes a real conflict stopped — these are the ones to read
  stale_errors  "Stale expected state" failures in the cost ledger (the
                pre-retry signal; this is the number that has to fall)`;

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args = process.argv.slice(2), io = process) {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  const tool = option(args, '--tool') || 'nexus_task_update';
  const rawHours = option(args, '--hours');
  // parseInt stops at the first non-digit, so "1.5", "6hours" and "24abc" would
  // all be silently accepted as 1/6/24. Require the whole argument to be digits.
  const hours = rawHours === undefined ? 24 : (/^\d+$/.test(rawHours.trim()) ? Number(rawHours) : NaN);
  if (!Number.isInteger(hours) || hours < 1) throw new Error('--hours must be a positive integer');

  const summary = gauge(tool, hours);
  if (!summary) throw new Error('lock gauge unavailable (ledger unreadable)');
  io.stdout.write(args.includes('--json')
    ? `${JSON.stringify(summary, null, 2)}\n`
    : `${formatGauge(summary)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`lock-health: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, HELP };
