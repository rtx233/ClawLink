import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { perform } = require('./paseo-core.cjs');
let client;
try {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const { connectToDaemon } = await import(pathToFileURL(process.argv[2]).href);
  client = await connectToDaemon({ timeout: 10000 });
  const result = await perform(client, input);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
} finally {
  await client?.close().catch(() => {});
}
