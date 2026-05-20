/**
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'com.agent-im.desktop',
  productName: 'Agent-IM',
  directories: {
    output: 'release',
    buildResources: 'assets',
  },
  files: [
    'dist-electron/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'src',
      to: 'app/src',
    },
    {
      from: 'wrangler.toml',
      to: 'app/wrangler.toml',
    },
    {
      from: 'dist-electron/orchestrator-entry.cjs',
      to: 'app/dist-electron/orchestrator-entry.cjs',
    },
    {
      from: 'dist-electron/agent-server.cjs',
      to: 'app/dist-electron/agent-server.cjs',
    },
    {
      from: 'node_modules',
      to: 'app/node_modules',
      filter: ['**/*'],
    },
  ],
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    icon: 'assets/icon.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Agent-IM',
  },
}
