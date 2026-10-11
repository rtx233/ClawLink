// This allowlist is shared by both platforms. Never package a workspace glob:
// the workspace can contain live credentials, routes, histories and backups.
module.exports = {
  serverFiles: ['index.js', 'adapters.js', 'native.js', 'runtime.js', 'cli.js', 'pi.js', 'paseo.js', 'paseo-core.cjs', 'paseo-worker.mjs', 'messaging.js', 'ai-client.js', 'commands.js', 'permissions.js'],
  documents: ['README.md', 'RELEASE_CHECKLIST.md']
};
