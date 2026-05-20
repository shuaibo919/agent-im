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
    '!.wrangler',
    '!.wrangler/**/*',
  ],
  extraResources: [
    {
      from: 'src/db',
      to: 'app/src/db',
    },
    {
      from: 'src/web',
      to: 'app/src/web',
    },
    {
      from: 'src/index.ts',
      to: 'app/src/index.ts',
    },
    {
      from: 'src/types.ts',
      to: 'app/src/types.ts',
    },
    {
      from: 'src/lib',
      to: 'app/src/lib',
    },
    {
      from: 'src/routes',
      to: 'app/src/routes',
    },
    {
      from: 'src/services',
      to: 'app/src/services',
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
      filter: [
        'wrangler/**',
        '@cloudflare/workerd-*/**',
        'miniflare/**',
        'ohash/**',
        'unenv/**',
        'defu/**',
        'youch/**',
        'consola/**',
        'pathe/**',
        'magic-string/**',
        'sourcemap-codec/**',
        'exit-hook/**',
        'glob-to-regexp/**',
        'stoppable/**',
        'selfsigned/**',
        'node-forge/**',
        '.bin/wrangler*',
        '!**/*.d.ts',
        '!**/*.d.mts',
        '!**/*.map',
        '!**/*.sqlite',
        '!**/README.md',
        '!**/CHANGELOG*',
        '!**/LICENSE*',
        '!**/.github/**',
        '!**/docs/**',
        '!**/test/**',
        '!**/tests/**',
        '!**/.wrangler/**',
      ],
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
