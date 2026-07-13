#!/usr/bin/env node
const {
  readTransitions,
  findTransition,
  buildCompensation,
} = require('../lib/transition-log');

const HELP = `praxis-mind transition log

Usage:
  transition-log list [--limit N] [--log PATH]
  transition-log show <transaction-id> [--log PATH]
  transition-log compensate <transaction-id> [--log PATH]

This CLI is read-only. "compensate" prints a payload for human/agent-initiated
application; it never mutates Nexus, the vault, or Cortex.`;

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function main(args = process.argv.slice(2), io = process) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }

  const command = args[0];
  const transactionId = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const logPath = option(args, '--log');

  if (command === 'list') {
    const parsedLimit = Number.parseInt(option(args, '--limit') || '20', 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) throw new Error('--limit must be a positive integer');
    const records = readTransitions(logPath).slice(-parsedLimit).reverse().map((record) => ({
      transaction_id: record.transaction_id,
      completed_at: record.completed_at,
      tool: record.tool,
      caller: record.caller?.identity,
      target: record.target,
      verdict: record.verdict,
    }));
    io.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }

  if (!['show', 'compensate'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (!transactionId) throw new Error(`${command} requires a transaction id`);
  const record = findTransition(transactionId, logPath);
  if (!record) throw new Error(`Transaction not found: ${transactionId}`);
  const output = command === 'show' ? record : buildCompensation(record);
  io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`transition-log: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, HELP };
