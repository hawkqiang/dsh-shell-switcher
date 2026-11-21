/**
 * Shell platform switcher — host half.
 *
 * Owns which `ctx.shell` executor and which shell tool this profile mounts.
 * The shipped bundle always mounts `dsh-bash-sandbox` (non-Windows) or
 * `dsh-pwsh-sandbox` (Windows) and the matching tool; those rows are disabled
 * by this bundle's patch and re-mounted here from the selected platform:
 *
 *   windows — pwsh (PowerShell 7) through the sandboxing executor + pwsh tool
 *   linux   — bash through the sandboxing executor + bash tool
 *   macos   — bash through the seatbelt executor      + bash tool
 *   android — bash through dsh-bash-local (unconfined) + bash tool
 *
 * "android" exists because Android kernels give apps no usable sandbox
 * backend (no unprivileged user namespaces for bubblewrap, no enforced
 * Landlock), so the confined executor fails closed with SANDBOX_UNAVAILABLE
 * and no command can run. Selecting android is an explicit, model-visible
 * choice to run unconfined bash on that host.
 *
 * The selection is one profile-wide config field (`platform`), persisted
 * through the config editor; selecting a platform restarts this plugin, which
 * remounts the executor and tool pair.
 */

import { existsSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import LocalBash from '@deepseek-ai/dsh-bash-local'
import SandboxBash from '@deepseek-ai/dsh-bash-sandbox'
import SandboxPwsh from '@deepseek-ai/dsh-pwsh-sandbox'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'

export const name = 'shell-platform'
export const inject = ['systemPrompt']

/** Settings namespace shared with the browser half. */
export const API_PREFIX = '/shell-platform/api'
export const PLATFORMS = Object.freeze(['windows', 'linux', 'android', 'macos'])

/** This plugin's config: one platform, or `auto` for the host's own platform. */
export const Config = z.object({
  platform: z.string().default('auto'),
})

/** Map Node's `process.platform` onto the four selectable platforms. */
export function detectPlatform(platform = process.platform) {
  // Termux-style Android hosts frequently run a glibc Node under a compatibility
  // loader, so `process.platform` reports "linux" while the kernel is Android.
  // The host markers below are what actually decides whether a sandbox backend
  // can work, so they win over the platform string.
  if (isAndroidHost()) return 'android'
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

/** True when the running host is Android (Termux, or an Android kernel). */
export function isAndroidHost() {
  if (process.platform === 'android') return true
  if (typeof process.env.TERMUX_VERSION === 'string' && process.env.TERMUX_VERSION !== '') return true
  if (typeof process.env.PREFIX === 'string' && process.env.PREFIX.includes('/com.termux/')) return true
  return ANDROID_MARKERS.some(marker => {
    try {
      return existsSync(marker)
    } catch {
      return false
    }
  })
}

/** Files present on Android and absent on desktop Linux. */
const ANDROID_MARKERS = [
  '/system/build.prop',
  '/data/data/com.termux/files/usr/bin/bash',
]

/**
 * Android's executor: the shipped local bash executor, which runs commands
 * unconfined, plus the one capability fact the permission presets require —
 * `sandboxMode`. `@deepseek-ai/dsh-permission-presets` refuses to compose over
 * an executor that reports no mode, so a bare `dsh-bash-local` cannot sit in
 * this composition at all.
 *
 * The reported mode is the deployment default, exactly what
 * `dsh-bash-sandbox` reports; what differs is enforcement: this executor never
 * calls `ctx.sandbox.confine`, because no backend on Android can enforce it.
 * Commands therefore run unconfined while the policy, approval and file-fence
 * surfaces keep behaving normally.
 */
export class AndroidBashExecutor extends LocalBash {
  static inject = ['subprocess', 'sandboxPolicy']

  constructor(ctx, config) {
    super(ctx, config)
    this.mode = ctx.sandboxPolicy.defaultMode
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  get sandboxMode() {
    return this.mode
  }

  /** Carry the per-call policy so callers see the same policy as any executor. */
  resolve(request) {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }
}

/**
 * One platform's shell composition. `executorConfig` is exactly the config the
 * shipped bundle gives that executor; `confined` is the honest confinement
 * story surfaced to the model and the toolbar.
 */
const CHANNELS = {
  windows: {
    label: 'Windows',
    executor: SandboxPwsh,
    executorName: '@deepseek-ai/dsh-pwsh-sandbox',
    executorConfig: {},
    tool: ToolPwsh,
    toolName: '@deepseek-ai/dsh-tool-pwsh',
    shell: 'pwsh',
    dialect: 'PowerShell',
    confined: 'The Windows ACL backend confines what it can (partial enforcement).',
  },
  linux: {
    label: 'Linux',
    executor: SandboxBash,
    executorName: '@deepseek-ai/dsh-bash-sandbox',
    executorConfig: { timeoutMs: 60000 },
    tool: ToolBash,
    toolName: '@deepseek-ai/dsh-tool-bash',
    shell: 'bash',
    dialect: 'bash',
    confined: 'Commands run confined by the DSH sandbox (bubblewrap or Landlock); a host with no usable runner fails closed with SANDBOX_UNAVAILABLE.',
  },
  macos: {
    label: 'macOS',
    executor: SandboxBash,
    executorName: '@deepseek-ai/dsh-bash-sandbox',
    executorConfig: { timeoutMs: 60000 },
    tool: ToolBash,
    toolName: '@deepseek-ai/dsh-tool-bash',
    shell: 'bash',
    dialect: 'bash',
    confined: 'Commands run confined by the DSH sandbox (Seatbelt).',
  },
  android: {
    label: 'Android',
    executor: AndroidBashExecutor,
    executorName: '@deepseek-ai/dsh-bash-local (unconfined)',
    executorConfig: { timeoutMs: 60000 },
    tool: ToolBash,
    toolName: '@deepseek-ai/dsh-tool-bash',
    shell: 'bash',
    dialect: 'bash',
    confined: 'Commands run through the UNCONFINED local bash executor: Android offers no usable sandbox backend, so workspace-write does not restrict writes made by commands (the file tools keep their own in-process fence).',
  },
}

function resolvePlatform(value) {
  const requested = typeof value === 'string' && value !== '' ? value : 'auto'
  if (requested === 'auto') return detectPlatform()
  if (PLATFORMS.includes(requested)) return requested
  throw new Error(`shell-platform: unknown platform "${requested}"; expected auto or one of ${PLATFORMS.join(', ')}`)
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJson(req, limit = 8 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  const parsed = JSON.parse(raw)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

function describe(platform, detected) {
  const channel = CHANNELS[platform]
  return {
    ok: true,
    platform,
    detected,
    automatic: platform === detected,
    shell: channel.shell,
    dialect: channel.dialect,
    executor: channel.executorName,
    tool: channel.toolName,
    confined: channel.confined,
    options: PLATFORMS.map(id => ({
      id,
      label: CHANNELS[id].label,
      shell: CHANNELS[id].shell,
      confined: id !== 'android',
      mounted: id === platform,
    })),
  }
}

export function apply(ctx, config = {}) {
  const platform = resolvePlatform(config.platform)
  const detected = detectPlatform()
  const channel = CHANNELS[platform]

  // Mounted as children of this plugin's fiber: a restart of this plugin (the
  // config editor's path for a changed field) disposes both and re-applies.
  ctx.plugin(channel.executor, channel.executorConfig)
  ctx.plugin(channel.tool, {})

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'shell-platform',
    order: 690,
    text: [
      `Shell platform: ${channel.label}. Commands run through ${channel.executorName} and the ${channel.toolName} tool in the ${channel.dialect} dialect.`,
      channel.confined,
      platform === 'android'
        ? 'Never rely on workspace-write to contain commands here; keep destructive commands inside the workspace and prefer the file tools for edits.'
        : `If a command fails with SANDBOX_UNAVAILABLE, the host has no usable sandbox runner; tell the user instead of retrying unconfined, and only switch the platform chip if the user asks for it.`,
    ].join(' '),
  }), 'shell-platform: prompt')

  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') return

  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry

  const handler = async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'only GET and POST are supported' })
      }
      const origin = req.headers?.origin
      if (typeof origin === 'string' && origin !== '') {
        let originHost
        try { originHost = new URL(origin).host } catch { originHost = null }
        if (!originHost || originHost !== req.headers?.host) {
          return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        }
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      let rest = url.pathname.slice(API_PREFIX.length)
      if (rest.length > 1 && rest.endsWith('/')) rest = rest.slice(0, -1)
      if (rest === '/state') {
        return sendJson(res, 200, describe(platform, detected))
      }
      if (rest === '/select') {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '/select only supports POST' })
        const body = await readJson(req)
        if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid json' })
        const next = body.platform
        if (!PLATFORMS.includes(next) && next !== 'auto') {
          return sendJson(res, 400, { ok: false, error: `unknown platform: ${String(next)}` })
        }
        if (editor === undefined || entry === undefined) {
          return sendJson(res, 501, { ok: false, error: 'this profile cannot save the selection (no config editor)' })
        }
        if (resolvePlatform(next) === platform && (next !== 'auto' || config.platform === 'auto')) {
          return sendJson(res, 200, { ok: true, platform })
        }
        await editor.edit(entry, current => ({ ...current, platform: next }))
        return sendJson(res, 200, { ok: true, platform: resolvePlatform(next) })
      }
      return sendJson(res, 404, { ok: false, error: `unknown route "${rest}"` })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }), 'shell-platform: api')
}