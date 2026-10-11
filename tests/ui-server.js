const { fixture } = require('./helpers');
const path = require('node:path');
fixture({ workers: false, port: 4181, ...(process.env.CLAWLINK_TEST_PUBLIC_DIR ? { publicDir: path.resolve(process.env.CLAWLINK_TEST_PUBLIC_DIR) } : {}) }).then(f => {
  console.log(`UI fixture: ${f.origin}`);
  process.on('SIGTERM', () => f.close().then(() => process.exit(0)));
  process.on('SIGINT', () => f.close().then(() => process.exit(0)));
});
