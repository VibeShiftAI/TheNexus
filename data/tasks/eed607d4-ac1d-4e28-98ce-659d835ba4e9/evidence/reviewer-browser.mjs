import path from 'node:path';
import { fileURLToPath } from 'node:url';
const evidence = path.dirname(fileURLToPath(import.meta.url));
process.env.CHECK_OUT = path.join(evidence, 'browser');
process.env.CHECK_PACKAGE = path.join(evidence, 'browser', 'screens');
await import('../../../../dashboard/scripts/chat-steps-browser-check.mjs');
