// VARCO Sound bridge — drives the sound.varco.ai web API with the user's own web login.
// Every agent session gets varco_sound_* host tools; the renderer lists generated projects for listening.
//
// Auth: cookies of the Electron session partition PARTITION (user logs in once in our window).
// Requests run as same-origin fetch() inside a hidden sound.varco.ai page, exactly like the web app.

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')

const ORIGIN = 'https://sound.varco.ai'
const PARTITION = 'persist:varco-sound'
const DEFAULT_OUT = path.join(os.homedir(), 'Music', 'VARCO Sound')
const POLL_MS = 2500
const GEN_TIMEOUT_MS = 10 * 60 * 1000
const PREVIEW_CACHE_MAX = 60

let state = null

class LoginRequired extends Error {}

exports.activate = async (ctx) => {
  const { BrowserWindow, shell } = require('electron')
  state = { worker: null, workerReady: null, loginWin: null, loginTimer: null, previews: new Map(), active: new Set(), disposed: false }

  // ---------- web session ----------
  const getWorker = () => {
    if (state.worker && !state.worker.isDestroyed() && state.workerReady) return state.workerReady
    const win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true } })
    state.worker = win
    state.workerReady = win.loadURL(ORIGIN + '/app/env.js').then(
      () => win,
      (e) => {
        state.workerReady = null
        throw e
      }
    )
    return state.workerReady
  }

  const rawRequest = async (method, url, opts = {}) => {
    const win = await getWorker()
    const payload = JSON.stringify({ method, url, ...opts })
    return win.webContents.executeJavaScript(`(async () => {
      const a = ${payload};
      const init = { method: a.method, credentials: 'include', headers: {} };
      if (a.json !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(a.json) }
      if (a.form) { const fd = new FormData(); for (const [k, v] of Object.entries(a.form)) fd.append(k, String(v)); init.body = fd }
      const r = await fetch(a.url, init);
      const ct = r.headers.get('content-type') || '';
      let body;
      if (a.binary && r.ok) {
        const b = new Uint8Array(await r.arrayBuffer()); let s = '';
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        body = btoa(s);
      } else body = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
      return { status: r.status, contentType: ct, body };
    })()`)
  }

  const api = async (method, url, opts) => {
    const r = await rawRequest(method, url, opts)
    if (r.status === 401) {
      openLogin()
      throw new LoginRequired('VARCO Sound login required. A login window was opened in OMP Studio; ask the user to log in there, then retry.')
    }
    if (r.status === 402) throw new Error('VARCO Sound: insufficient credits.')
    if (r.status < 200 || r.status >= 300) {
      const detail = r.body && typeof r.body === 'object' ? JSON.stringify(r.body.detail ?? r.body) : String(r.body || '').slice(0, 300)
      throw new Error(`VARCO Sound ${method} ${url} failed: HTTP ${r.status} ${detail}`)
    }
    return r
  }

  const me = async () => {
    const r = await rawRequest('GET', '/api/users/me')
    return r.status === 200 ? r.body : null
  }

  const openLogin = () => {
    if (state.disposed) return
    if (state.loginWin && !state.loginWin.isDestroyed()) {
      state.loginWin.focus()
      return
    }
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      title: 'VARCO Sound 로그인',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true }
    })
    state.loginWin = win
    win.loadURL(ORIGIN + '/app/create')
    ctx.app.ui.notify('info', 'VARCO Sound 로그인 창을 열었습니다. 로그인하면 자동으로 닫힙니다.')
    ctx.channel.emit('vs.auth', { loggedIn: false, loginOpen: true })
    clearInterval(state.loginTimer)
    state.loginTimer = setInterval(async () => {
      if (win.isDestroyed()) return clearInterval(state.loginTimer)
      try {
        if (await me()) {
          clearInterval(state.loginTimer)
          ctx.app.ui.notify('info', 'VARCO Sound 로그인 완료')
          ctx.channel.emit('vs.auth', { loggedIn: true })
          ctx.channel.emit('vs.changed', {})
          win.close()
        }
      } catch {
        // worker still loading; next tick
      }
    }, 2000)
    win.on('closed', () => {
      clearInterval(state.loginTimer)
      ctx.channel.emit('vs.auth', { loginOpen: false })
    })
  }

  // ---------- model ----------
  const outDir = () => {
    const v = ctx.settings.get().outputDir
    return path.resolve(typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_OUT)
  }
  const safeName = (s) =>
    String(s || 'untitled')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 80) || 'untitled'

  // Normalize a project payload: tracks -> candidate files (first candidate = currently selected clip).
  const shape = (p) => {
    const files = new Map((p.files || []).map((f) => [f.id, f]))
    const used = new Set()
    const tracks = (p.tracks || [])
      .filter((t) => t && t.id)
      .map((t) => {
        const clip = (t.clips || [])[0] || {}
        const ids = clip.candidates && clip.candidates.length ? clip.candidates : clip.fileId ? [clip.fileId] : []
        const candidates = ids
          .map((id) => files.get(id))
          .filter(Boolean)
          .map((f) => {
            used.add(f.id)
            return { id: f.id, name: f.name, prompt: f.prompt || null, tags: f.tags || [], size: f.size, mimeType: f.mimeType }
          })
        return {
          id: t.id,
          name: t.name,
          category: t.category || null,
          duration: clip.attribute && typeof clip.attribute.duration === 'number' ? clip.attribute.duration : null,
          selectedFileId: clip.fileId || null,
          candidates
        }
      })
    const extraAudio = (p.files || [])
      .filter((f) => !used.has(f.id) && /^audio\//.test(f.mimeType || ''))
      .map((f) => ({ id: f.id, name: f.name, prompt: f.prompt || null, tags: f.tags || [], size: f.size, mimeType: f.mimeType }))
    if (extraAudio.length) tracks.push({ id: 'extra', name: 'Other audio', category: null, duration: null, selectedFileId: null, candidates: extraAudio })
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      withMusic: !!(p.source && p.source.withMusic),
      error: p.errorReason || p.error || p.reason || null,
      tracks
    }
  }

  const listProjects = async () => {
    const r = await api('GET', '/api/projects')
    const items = Array.isArray(r.body) ? r.body : (r.body && r.body.items) || []
    return items.map(shape).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }
  const getProject = async (id) => shape((await api('GET', `/api/projects/${encodeURIComponent(id)}`)).body)

  const prompts = async () => (await ctx.storage.get('prompts')) || {}
  const rememberPrompt = async (id, prompt) => {
    const all = await prompts()
    all[id] = prompt
    await ctx.storage.set('prompts', all)
  }

  const createProject = async (prompt, withMusic) => {
    const r = await api('POST', '/api/projects', { form: { prompt, withMusic: String(!!withMusic) } })
    const id = r.body && (r.body.projectId || r.body.id)
    if (!id) throw new Error('VARCO Sound did not return a project id: ' + JSON.stringify(r.body))
    await rememberPrompt(id, prompt)
    state.active.add(id)
    ctx.channel.emit('vs.changed', { id })
    return id
  }

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      if (signal) signal.addEventListener('abort', () => (clearTimeout(t), reject(new Error('cancelled'))), { once: true })
    })

  const waitProject = async (id, signal, onTick) => {
    const start = Date.now()
    try {
      for (;;) {
        const p = await getProject(id)
        if (p.status !== 'processing' && p.status !== 'pending' && p.status !== 'queued') return p
        if (Date.now() - start > GEN_TIMEOUT_MS) throw new Error(`Project ${id} still ${p.status} after ${GEN_TIMEOUT_MS / 60000} min. Check later with varco_sound_get.`)
        if (onTick) onTick(Math.round((Date.now() - start) / 1000))
        await sleep(POLL_MS, signal)
      }
    } finally {
      state.active.delete(id)
      ctx.channel.emit('vs.changed', { id })
    }
  }

  const fileUrl = (projectId, fileId, original) =>
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}${original ? '?original=true' : ''}`

  const downloadFiles = async (project, fileIds, dir, format) => {
    const target = dir ? path.resolve(dir) : path.join(outDir(), `${safeName(project.name)}_${project.id.slice(0, 8)}`)
    await fsp.mkdir(target, { recursive: true })
    const all = project.tracks.flatMap((t) => t.candidates)
    const pick = fileIds && fileIds.length ? all.filter((f) => fileIds.includes(f.id)) : all
    if (!pick.length) throw new Error('No matching audio files in project ' + project.id)
    const saved = []
    for (const f of pick) {
      const original = format !== 'mp3'
      const r = await api('GET', fileUrl(project.id, f.id, original), { binary: true })
      const ext = original ? path.extname(f.name) || '.wav' : '.mp3'
      const file = path.join(target, safeName(path.basename(f.name, path.extname(f.name))) + ext)
      await fsp.writeFile(file, Buffer.from(r.body, 'base64'))
      saved.push({ fileId: f.id, path: file })
    }
    return { dir: target, saved }
  }

  const describe = (p, prompt, saved) => {
    const pathOf = new Map(((saved && saved.saved) || []).map((s) => [s.fileId, s.path]))
    const lines = [`Project "${p.name}" (id ${p.id}) — ${p.status}${p.withMusic ? ', with music' : ''}${prompt ? `\nPrompt: ${prompt}` : ''}`]
    if (p.error) lines.push(`Error: ${typeof p.error === 'string' ? p.error : JSON.stringify(p.error)}`)
    for (const t of p.tracks) {
      lines.push(`Track "${t.name}"${t.category ? ` [${t.category}]` : ''}${t.duration ? ` ${t.duration.toFixed(2)}s` : ''}${t.candidates[0] && t.candidates[0].prompt ? ` — "${t.candidates[0].prompt}"` : ''}`)
      t.candidates.forEach((c, k) => {
        lines.push(`  ${k + 1}. ${c.name} (fileId ${c.id})${c.id === t.selectedFileId ? ' [selected]' : ''}${pathOf.has(c.id) ? ` → ${pathOf.get(c.id)}` : ''}`)
      })
    }
    if (saved) lines.push(`Saved ${saved.saved.length} file(s) to ${saved.dir}`)
    return lines.join('\n')
  }

  const saveFile = async (projectId, fileId, file) => {
    const r = await api('GET', fileUrl(projectId, fileId, true), { binary: true })
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, Buffer.from(r.body, 'base64'))
    return file
  }

  const reviewModule = path.join(ctx.pluginDir, 'review.js')
  delete require.cache[require.resolve(reviewModule)]
  const reviews = require(reviewModule).createReviews({ ctx, createProject, waitProject, saveFile, outDir, safeName })
  state.reviews = reviews
  await reviews.load()

  // ---------- host tools ----------
  const tool = (definition, fn) =>
    ctx.registerHostTool({
      definition,
      async execute(args, exec) {
        try {
          return { content: [{ type: 'text', text: await fn(args || {}, exec) }] }
        } catch (e) {
          return { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true }
        }
      }
    })

  tool(
    {
      name: 'varco_sound_generate',
      label: 'VARCO Sound: generate',
      description:
        'Generate game/video sound (SFX, ambience, foley, optional music) from a text prompt with VARCO Sound (sound.varco.ai, the user\'s web account). ' +
        'One prompt can yield several tracks (the service splits a scene into sounds); each track gets 3 candidate takes. Takes ~10-60 s. ' +
        'Write the prompt in English, concrete and physical: source, material, action, space, length/feel (e.g. "Short bright magical coin pickup chime, sparkling, under 1 second"). ' +
        'Use this for ONE sound. For a set of sounds (e.g. "make the sounds this game needs") use varco_sound_batch so the user can listen and pick a take per sound. By default waits, then saves all candidate WAVs locally and returns their paths.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Sound description (English recommended).' },
          withMusic: { type: 'boolean', description: 'Also generate background music (costs more). Default false.' },
          wait: { type: 'boolean', description: 'Wait for completion. Default true. false returns the project id immediately.' },
          save: { type: 'boolean', description: 'Download the results after completion. Default true.' },
          saveDir: { type: 'string', description: 'Absolute folder to save into (e.g. a Unity Assets/Audio/... folder). Default: plugin output folder/<project>.' },
          format: { type: 'string', enum: ['wav', 'mp3'], description: 'Saved format. Default wav (original).' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    },
    async (a, exec) => {
      const prompt = String(a.prompt || '').trim()
      if (!prompt) throw new Error('prompt is empty')
      const id = await createProject(prompt, a.withMusic)
      if (a.wait === false) return `Started project ${id}. Check it with varco_sound_get {projectId: "${id}"}.`
      const p = await waitProject(id, exec.signal, (sec) => exec.update({ content: [{ type: 'text', text: `VARCO Sound generating… ${sec}s` }] }))
      if (p.status !== 'completed') return describe(p, prompt) + '\nGeneration did not complete successfully.'
      const saved = a.save === false ? null : await downloadFiles(p, null, a.saveDir, a.format)
      return describe(p, prompt, saved)
    }
  )

  tool(
    {
      name: 'varco_sound_list',
      label: 'VARCO Sound: list',
      description: 'List recent VARCO Sound projects (newest first) with their tracks and candidate file ids.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' }, query: { type: 'string', description: 'Filter by name/prompt substring.' } },
        additionalProperties: false
      }
    },
    async (a) => {
      const q = String(a.query || '').toLowerCase()
      const known = await prompts()
      const items = (await listProjects())
        .filter((p) => !q || p.name.toLowerCase().includes(q) || String(known[p.id] || '').toLowerCase().includes(q) || p.tracks.some((t) => t.candidates.some((c) => String(c.prompt || '').toLowerCase().includes(q))))
        .slice(0, a.limit || 20)
      if (!items.length) return 'No projects.'
      return items
        .map((p) => `- ${p.name} (id ${p.id}) ${p.status} ${String(p.createdAt).slice(0, 16).replace('T', ' ')} — ${p.tracks.map((t) => `${t.name}×${t.candidates.length}`).join(', ') || 'no tracks'}`)
        .join('\n')
    }
  )

  tool(
    {
      name: 'varco_sound_get',
      label: 'VARCO Sound: get project',
      description: 'Show one VARCO Sound project: status, tracks, candidate files (ids, prompts). Optionally wait until it finishes.',
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string' }, wait: { type: 'boolean', description: 'Wait while processing. Default false.' } },
        required: ['projectId'],
        additionalProperties: false
      }
    },
    async (a, exec) => {
      const p = a.wait ? await waitProject(a.projectId, exec.signal) : await getProject(a.projectId)
      return describe(p, (await prompts())[p.id])
    }
  )

  tool(
    {
      name: 'varco_sound_download',
      label: 'VARCO Sound: download',
      description: 'Save VARCO Sound project audio to disk (all candidates, or chosen fileIds). Use to put chosen takes into a game project folder.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          fileIds: { type: 'array', items: { type: 'string' }, description: 'Subset of candidate file ids. Default all.' },
          saveDir: { type: 'string', description: 'Absolute folder. Default: plugin output folder/<project>.' },
          format: { type: 'string', enum: ['wav', 'mp3'], description: 'Default wav.' }
        },
        required: ['projectId'],
        additionalProperties: false
      }
    },
    async (a) => {
      const p = await getProject(a.projectId)
      if (p.status !== 'completed') throw new Error(`Project ${p.id} is ${p.status}; nothing to download yet.`)
      return describe(p, null, await downloadFiles(p, a.fileIds, a.saveDir, a.format))
    }
  )

  tool(
    {
      name: 'varco_sound_status',
      label: 'VARCO Sound: status',
      description: 'Check the VARCO Sound login (opens a login window for the user if logged out), plan tier and credit cost per action.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    async () => {
      const user = await me()
      if (!user) {
        openLogin()
        return 'Not logged in. A login window was opened in OMP Studio; ask the user to log in, then retry.'
      }
      const credits = (await api('GET', '/api/credits')).body || {}
      const costs = Object.values(credits)
        .map((c) => `${c.code}: ${(c.amounts || []).map((x) => `${x.amount} ${x.unit}`).join(', ')}`)
        .join('\n')
      return `Logged in as ${user.email} (tier ${user.tier}). Output folder: ${outDir()}\nCosts:\n${costs}`
    }
  )

  tool(
    {
      name: 'varco_sound_show',
      label: 'VARCO Sound: show list',
      description: 'Open the VARCO Sound list in OMP Studio so the user can listen to and compare the generated takes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    },
    async () => {
      ctx.channel.emit('vs.show', {})
      return 'Opened the VARCO Sound list for the user.'
    }
  )

  tool(
    {
      name: 'varco_sound_batch',
      label: 'VARCO Sound: generate batch for review',
      description:
        'Generate several game sounds at once and let the USER choose the takes. Use this when the user asks for "the sounds this game needs" or any set of sounds. ' +
        'For each item give a short title, where/when it plays in the game (purpose, shown to the user while choosing, in the user\'s language), an English prompt, and the target fileName. ' +
        'Every item yields 3 candidate takes. The user reviews items one by one in the VARCO Sound panel ("this sound is for X — listen and pick"), may regenerate or skip, or press auto-select for the rest. ' +
        'Chosen takes are saved as WAV (saveDir/fileName). Blocks until the user finishes or waitMinutes passes (then poll varco_sound_review). ' +
        'autoSelect:true skips the human review and keeps the service-recommended take of every item.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Batch title shown to the user, e.g. "던전 전투 SFX".' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique key, e.g. "sfx_sword_slash".' },
                title: { type: 'string', description: 'Short name for the user, e.g. "검 휘두르기".' },
                purpose: { type: 'string', description: 'Where/when it plays, e.g. "플레이어 기본 공격 3타 모션마다 재생".' },
                prompt: { type: 'string', description: 'English generation prompt, concrete and physical.' },
                fileName: { type: 'string', description: 'Output file name without folder, e.g. "sfx_sword_slash.wav". Default: id.' },
                saveDir: { type: 'string', description: 'Absolute folder override for this item.' },
                withMusic: { type: 'boolean' }
              },
              required: ['title', 'purpose', 'prompt'],
              additionalProperties: false
            }
          },
          saveDir: { type: 'string', description: 'Absolute folder for the chosen takes, e.g. a Unity Assets/Audio/SFX folder. Default: plugin output folder/<title>.' },
          autoSelect: { type: 'boolean', description: 'Skip human review; keep the recommended take of every item. Default false.' },
          waitMinutes: { type: 'number', minimum: 0, maximum: 120, description: 'How long to wait for the user before returning (default 30). 0 = return immediately.' }
        },
        required: ['items'],
        additionalProperties: false
      }
    },
    async (a, exec) => {
      const r = reviews.start({ title: a.title, items: a.items, saveDir: a.saveDir, autoSelect: a.autoSelect })
      if (!a.autoSelect) ctx.channel.emit('vs.reviewOpen', { id: r.id })
      const minutes = a.waitMinutes == null ? 30 : a.waitMinutes
      if (minutes > 0) {
        exec.update({ content: [{ type: 'text', text: a.autoSelect ? 'VARCO Sound: generating and auto-selecting…' : 'VARCO Sound: waiting for the user to choose takes in the VARCO Sound panel…' }] })
        await reviews.wait(r.id, exec.signal, minutes * 60000)
      }
      return reviews.describe(r)
    }
  )

  tool(
    {
      name: 'varco_sound_review',
      label: 'VARCO Sound: review status',
      description: 'Status/result of a varco_sound_batch review (chosen takes and saved paths). Without reviewId lists recent reviews. wait:true blocks until the user finishes.',
      parameters: {
        type: 'object',
        properties: {
          reviewId: { type: 'string' },
          wait: { type: 'boolean', description: 'Wait for the user to finish. Default false.' },
          waitMinutes: { type: 'number', minimum: 1, maximum: 120, description: 'Default 30.' },
          open: { type: 'boolean', description: 'Also bring the review up in the panel for the user.' }
        },
        additionalProperties: false
      }
    },
    async (a, exec) => {
      if (!a.reviewId) {
        const all = reviews.list().slice(0, 15)
        if (!all.length) return 'No reviews.'
        return all.map((r) => `- ${r.id} "${r.title}" ${r.status} — ${r.items.filter((i) => i.choice != null).length}/${r.items.length} decided`).join('\n')
      }
      const r = reviews.get(a.reviewId)
      if (a.open) ctx.channel.emit('vs.reviewOpen', { id: r.id })
      if (a.wait) await reviews.wait(r.id, exec.signal, (a.waitMinutes || 30) * 60000)
      return reviews.describe(r)
    }
  )

  ctx.channel.handle('vs.reviews', async () => reviews.list())
  ctx.channel.handle('vs.review.choose', async (p) => reviews.choose(p.id, p.key, p.fileId))
  ctx.channel.handle('vs.review.regenerate', async (p) => reviews.regenerate(p.id, p.key, p.prompt))
  ctx.channel.handle('vs.review.autoSelect', async (p) => reviews.autoSelect(p.id, !!p.finish))
  ctx.channel.handle('vs.review.finish', async (p) => reviews.finish(p.id))
  ctx.channel.handle('vs.review.cancel', async (p) => reviews.cancel(p.id))

  // ---------- renderer channel ----------
  ctx.channel.handle('vs.state', async () => {
    const user = await me()
    return { loggedIn: !!user, email: user ? user.email : null, tier: user ? user.tier : null, outDir: outDir() }
  })
  ctx.channel.handle('vs.login', async () => openLogin())
  ctx.channel.handle('vs.list', async () => {
    const known = await prompts()
    return (await listProjects()).map((p) => ({ ...p, prompt: known[p.id] || null }))
  })
  ctx.channel.handle('vs.generate', async (p) => {
    const prompt = String((p && p.prompt) || '').trim()
    if (!prompt) throw new Error('프롬프트를 입력하세요')
    const id = await createProject(prompt, p && p.withMusic)
    waitProject(id).catch((e) => ctx.log('wait failed', e && e.message))
    return id
  })
  ctx.channel.handle('vs.preview', async (p) => {
    const key = `${p.projectId}/${p.fileId}`
    if (state.previews.has(key)) return state.previews.get(key)
    const r = await api('GET', fileUrl(p.projectId, p.fileId, false), { binary: true })
    const value = { mime: r.contentType || 'audio/mpeg', data: r.body }
    state.previews.set(key, value)
    if (state.previews.size > PREVIEW_CACHE_MAX) state.previews.delete(state.previews.keys().next().value)
    return value
  })
  ctx.channel.handle('vs.save', async (p) => {
    const project = await getProject(p.projectId)
    const res = await downloadFiles(project, p.fileIds, null, 'wav')
    return res
  })
  ctx.channel.handle('vs.openFolder', async (p) => {
    const dir = (p && p.dir) || outDir()
    await fsp.mkdir(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
  })
  ctx.channel.handle('vs.openWeb', async (p) => {
    await shell.openExternal(p && p.projectId ? `${ORIGIN}/app/editor/${encodeURIComponent(p.projectId)}` : `${ORIGIN}/app/create`)
  })
}

exports.deactivate = () => {
  if (!state) return
  state.disposed = true
  if (state.reviews) state.reviews.dispose()
  clearInterval(state.loginTimer)
  for (const w of [state.worker, state.loginWin]) if (w && !w.isDestroyed()) w.destroy()
  state = null
}
