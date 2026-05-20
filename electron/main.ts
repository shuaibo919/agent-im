import { app, BrowserWindow, shell } from 'electron'
import { spawn, execSync, ChildProcess } from 'node:child_process'
import path from 'node:path'
import http from 'node:http'

const PORT = 8787
const PROXY_PORT = 9000
const BASE_URL = `http://localhost:${PORT}`

let mainWindow: BrowserWindow | null = null
let wranglerProcess: ChildProcess | null = null

function getProjectRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app')
  }
  return path.resolve(__dirname, '..')
}

function initDatabase(root: string): void {
  try {
    execSync('npx wrangler d1 execute agent-im-db --local --file=src/db/schema.sql', {
      cwd: root,
      stdio: 'ignore',
    })
    // Run migrations (ALTER TABLE etc. — errors expected if already applied)
    try {
      execSync('npx wrangler d1 execute agent-im-db --local --file=src/db/migrations.sql', {
        cwd: root,
        stdio: 'ignore',
      })
    } catch { /* migration already applied */ }
  } catch {
    // DB may already exist
  }
}

function startWrangler(root: string): ChildProcess {
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
    cwd: root,
    shell: true,
    stdio: 'pipe',
  })

  child.stdout?.on('data', (data) => {
    console.log(`[wrangler] ${data.toString().trim()}`)
  })
  child.stderr?.on('data', (data) => {
    console.error(`[wrangler] ${data.toString().trim()}`)
  })
  child.on('error', (err) => {
    console.error('Failed to start wrangler:', err)
  })

  return child
}

function waitForServer(maxAttempts = 20, interval = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0
    const check = () => {
      attempts++
      const req = http.get(`${BASE_URL}/api/status`, (res) => {
        if (res.statusCode === 200) {
          resolve(true)
        } else if (attempts < maxAttempts) {
          setTimeout(check, interval)
        } else {
          resolve(false)
        }
      })
      req.on('error', () => {
        if (attempts < maxAttempts) {
          setTimeout(check, interval)
        } else {
          resolve(false)
        }
      })
      req.end()
    }
    check()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'Agent-IM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadURL(`${BASE_URL}/chat`)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function killWrangler(): void {
  if (wranglerProcess && !wranglerProcess.killed) {
    if (process.platform === 'win32' && wranglerProcess.pid) {
      try {
        execSync(`taskkill /PID ${wranglerProcess.pid} /T /F`, { stdio: 'ignore' })
      } catch {
        wranglerProcess.kill()
      }
    } else {
      wranglerProcess.kill()
    }
    wranglerProcess = null
  }
}

// --- Orchestrator integration ---
let orchestratorProxy: ChildProcess | null = null

function startOrchestratorProxy(root: string): void {
  const distElectron = path.join(root, 'dist-electron')
  const orchestratorScript = path.join(distElectron, 'orchestrator-entry.cjs')
  const agentServerScript = path.join(distElectron, 'agent-server.cjs')

  orchestratorProxy = spawn('node', [
    orchestratorScript,
    '--port', String(PORT),
    '--proxy-port', String(PROXY_PORT),
  ], {
    cwd: root,
    shell: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      AGENT_SERVER_PATH: agentServerScript,
      APP_ROOT: root,
    },
  })

  orchestratorProxy.stdout?.on('data', (data) => {
    console.log(`[orchestrator] ${data.toString().trim()}`)
  })
  orchestratorProxy.stderr?.on('data', (data) => {
    console.error(`[orchestrator] ${data.toString().trim()}`)
  })
  orchestratorProxy.on('exit', (code) => {
    console.log(`[orchestrator] Process exited (code ${code})`)
  })
}

function killOrchestrator(): void {
  if (orchestratorProxy && !orchestratorProxy.killed) {
    if (process.platform === 'win32' && orchestratorProxy.pid) {
      try {
        execSync(`taskkill /PID ${orchestratorProxy.pid} /T /F`, { stdio: 'ignore' })
      } catch {
        orchestratorProxy.kill()
      }
    } else {
      orchestratorProxy.kill()
    }
    orchestratorProxy = null
  }
}

// --- App lifecycle ---

app.whenReady().then(async () => {
  const root = getProjectRoot()

  // Init DB
  initDatabase(root)

  // Start wrangler dev server
  wranglerProcess = startWrangler(root)

  // Wait for server to be ready
  const ready = await waitForServer()
  if (!ready) {
    console.error('Server failed to start within timeout')
    app.quit()
    return
  }

  // Start orchestrator (proxy + agent management)
  startOrchestratorProxy(root)

  createWindow()
})

app.on('window-all-closed', () => {
  killOrchestrator()
  killWrangler()
  app.quit()
})

app.on('before-quit', () => {
  killOrchestrator()
  killWrangler()
})

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
  }
})
