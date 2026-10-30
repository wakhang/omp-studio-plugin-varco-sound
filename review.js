// Selection reviews: the AI requests a batch of sounds, each with where/when it plays in the game.
// Every item yields candidate takes; the user auditions items one by one and picks a take (or skips),
// or auto-selects the service-recommended take. Finishing saves the chosen takes under the requested names.

const path = require('path')
const crypto = require('crypto')

const MAX_PARALLEL = 3
const KEEP_REVIEWS = 30
const OPEN = new Set(['generating', 'reviewing', 'saving'])

exports.createReviews = ({ ctx, createProject, waitProject, saveFile, outDir, safeName }) => {
  const reviews = new Map()
  const waiters = new Map() // reviewId -> Set<(force) => void>
  const queue = []
  let running = 0
  let disposed = false

  // ---------- persistence / notify ----------
  let persistTimer = null
  const persist = () => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      const list = [...reviews.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP_REVIEWS)
      ctx.storage.set('reviews', list).catch(() => {})
    }, 200)
  }
  const changed = (r) => {
    if (disposed) return
    r.updatedAt = Date.now()
    persist()
    ctx.channel.emit('vs.review', { id: r.id })
    for (const fn of [...(waiters.get(r.id) || [])]) fn(false)
  }

  // ---------- generation ----------
  const runLimited = (fn) =>
    new Promise((resolve, reject) => {
      const go = () => {
        running++
        fn()
          .then(resolve, reject)
          .finally(() => {
            running--
            if (queue.length) queue.shift()()
          })
      }
      if (running < MAX_PARALLEL) go()
      else queue.push(go)
    })

  const flatten = (p) => {
    const candidates = []
    for (const t of p.tracks) {
      for (const c of t.candidates) candidates.push({ fileId: c.id, name: c.name, track: t.name, category: t.category, prompt: c.prompt, tags: c.tags || [] })
    }
    const first = p.tracks[0]
    return {
      candidates,
      recommended: (first && first.selectedFileId) || (candidates[0] && candidates[0].fileId) || null,
      duration: first && first.duration ? first.duration : null
    }
  }

  const fail = (r, item, e) => {
    if (disposed) return // plugin reloading: keep "generating", load() resumes it
    item.status = 'failed'
    item.error = String((e && e.message) || e)
    afterItem(r)
  }

  const pollItem = async (r, item) => {
    let p
    try {
      p = await waitProject(item.projectId)
    } catch (e) {
      return fail(r, item, e)
    }
    if (p.status !== 'completed') return fail(r, item, `generation ${p.status}${p.error ? `: ${JSON.stringify(p.error)}` : ''}`)
    Object.assign(item, flatten(p), { status: 'ready', error: null })
    if (!item.candidates.length) return fail(r, item, 'no audio produced')
    if (r.autoRest && item.choice == null) item.choice = item.recommended
    afterItem(r)
  }

  const generateItem = (r, item) => {
    Object.assign(item, { status: 'generating', error: null, candidates: [], recommended: null, duration: null, choice: null, savedPath: null, projectId: null })
    changed(r)
    return runLimited(async () => {
      if (disposed || r.status === 'cancelled') return
      try {
        item.projectId = await createProject(item.prompt, item.withMusic)
      } catch (e) {
        return fail(r, item, e)
      }
      changed(r)
      await pollItem(r, item)
    })
  }

  const afterItem = (r) => {
    if (!OPEN.has(r.status)) return changed(r)
    const pending = r.items.some((i) => i.status === 'generating')
    if (!pending && r.status === 'generating') r.status = 'reviewing'
    if (!pending && r.finishWhenReady) {
      finish(r.id).catch((e) => ctx.log('finish failed', e && e.message))
      return
    }
    changed(r)
  }

  // ---------- public API ----------
  const get = (id) => {
    const r = reviews.get(id)
    if (!r) throw new Error(`Unknown review id "${id}".`)
    return r
  }
  const itemOf = (r, key) => {
    const item = r.items.find((i) => i.key === key)
    if (!item) throw new Error(`Unknown item "${key}" in review ${r.id}.`)
    return item
  }
  const editable = (r) => {
    if (r.status !== 'generating' && r.status !== 'reviewing') throw new Error(`Review ${r.id} is ${r.status}.`)
  }

  const start = ({ title, items, saveDir, autoSelect }) => {
    if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty array')
    const used = new Set()
    const r = {
      id: 'r_' + crypto.randomBytes(4).toString('hex'),
      title: String(title || 'Sound batch').trim(),
      saveDir: saveDir ? path.resolve(String(saveDir)) : null,
      status: 'generating',
      autoRest: !!autoSelect,
      finishWhenReady: !!autoSelect,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      items: items.map((it, k) => {
        const prompt = String((it && it.prompt) || '').trim()
        if (!prompt) throw new Error(`items[${k}].prompt is empty`)
        let key = safeName(String(it.id || it.fileName || `sound_${k + 1}`).replace(/\.\w+$/, '')).replace(/\s+/g, '_')
        while (used.has(key)) key += '_' + (k + 1)
        used.add(key)
        return {
          key,
          title: String(it.title || key),
          purpose: String(it.purpose || ''),
          prompt,
          withMusic: !!it.withMusic,
          fileName: it.fileName ? String(it.fileName) : null,
          saveDir: it.saveDir ? path.resolve(String(it.saveDir)) : null,
          projectId: null,
          status: 'generating',
          error: null,
          candidates: [],
          recommended: null,
          duration: null,
          choice: null,
          savedPath: null
        }
      })
    }
    reviews.set(r.id, r)
    for (const item of r.items) generateItem(r, item)
    return r
  }

  const choose = (id, key, fileId) => {
    const r = get(id)
    editable(r)
    const item = itemOf(r, key)
    if (fileId === 'skip') item.choice = 'skip'
    else if (fileId == null) item.choice = null
    else {
      if (!item.candidates.some((c) => c.fileId === fileId)) throw new Error('fileId is not a candidate of this item')
      item.choice = fileId
    }
    changed(r)
    return r
  }

  const regenerate = (id, key, prompt) => {
    const r = get(id)
    editable(r)
    const item = itemOf(r, key)
    if (item.status === 'generating') throw new Error('Item is still generating.')
    if (prompt && String(prompt).trim()) item.prompt = String(prompt).trim()
    r.status = 'generating'
    generateItem(r, item)
    return r
  }

  const finish = async (id) => {
    const r = get(id)
    editable(r)
    if (r.items.some((i) => i.status === 'generating')) {
      r.finishWhenReady = true
      changed(r)
      return r
    }
    r.status = 'saving'
    changed(r)
    const baseDir = r.saveDir || path.join(outDir(), safeName(r.title))
    for (const item of r.items) {
      if (item.status !== 'ready' || !item.choice || item.choice === 'skip') continue
      const cand = item.candidates.find((c) => c.fileId === item.choice)
      const ext = path.extname(cand ? cand.name : '') || '.wav'
      const base = item.fileName ? safeName(item.fileName.replace(/\.\w+$/, '')) : item.key
      const file = path.join(item.saveDir || baseDir, base + ext)
      try {
        await saveFile(item.projectId, item.choice, file)
        item.savedPath = file
        item.error = null
      } catch (e) {
        item.error = 'save failed: ' + String((e && e.message) || e)
      }
      changed(r)
    }
    r.status = 'done'
    r.finishWhenReady = false
    changed(r)
    return r
  }

  const autoSelect = async (id, andFinish) => {
    const r = get(id)
    editable(r)
    r.autoRest = true
    for (const item of r.items) if (item.status === 'ready' && item.choice == null) item.choice = item.recommended
    if (andFinish) return finish(id)
    changed(r)
    return r
  }

  const cancel = (id) => {
    const r = get(id)
    if (!OPEN.has(r.status)) return r
    r.status = 'cancelled'
    changed(r)
    return r
  }

  const wait = (id, signal, timeoutMs) =>
    new Promise((resolve) => {
      const r = get(id)
      if (!OPEN.has(r.status)) return resolve(r)
      const set = waiters.get(id) || new Set()
      waiters.set(id, set)
      let timer = null
      const done = () => {
        set.delete(check)
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', done)
        resolve(r)
      }
      function check(force) {
        if (force || !OPEN.has(r.status)) done()
      }
      set.add(check)
      timer = setTimeout(done, timeoutMs)
      if (signal) signal.addEventListener('abort', done, { once: true })
    })

  const list = () => [...reviews.values()].sort((a, b) => b.createdAt - a.createdAt)

  const describe = (r) => {
    const chosen = r.items.filter((i) => i.choice && i.choice !== 'skip').length
    const decided = r.items.filter((i) => i.choice != null).length
    const lines = [`Review "${r.title}" (reviewId ${r.id}) — ${r.status}; ${decided}/${r.items.length} decided, ${chosen} chosen`]
    r.items.forEach((i, k) => {
      let what
      if (i.status === 'generating') what = 'generating…'
      else if (i.status === 'failed') what = `FAILED: ${i.error}`
      else if (i.choice === 'skip') what = 'skipped by user (no take wanted)'
      else if (i.choice) {
        const n = i.candidates.findIndex((c) => c.fileId === i.choice) + 1
        what = `take ${n}${i.choice === i.recommended ? ' (recommended)' : ''}${i.savedPath ? ` → ${i.savedPath}` : ''}${i.error ? ` (${i.error})` : ''}`
      } else what = 'waiting for user choice'
      lines.push(`${k + 1}. ${i.key} — ${i.title}${i.purpose ? ` [${i.purpose}]` : ''}: ${what}`)
    })
    if (OPEN.has(r.status)) lines.push(`The user is still reviewing in the VARCO Sound panel. Call varco_sound_review {reviewId: "${r.id}", wait: true} to keep waiting.`)
    if (r.status === 'cancelled') lines.push('The user cancelled this review; nothing was saved.')
    return lines.join('\n')
  }

  const load = async () => {
    const saved = (await ctx.storage.get('reviews')) || []
    for (const r of saved) {
      reviews.set(r.id, r)
      if (r.status === 'saving') r.status = 'reviewing'
      for (const item of r.items) {
        if (item.status !== 'generating') continue
        if (!OPEN.has(r.status)) item.status = 'failed'
        else if (item.projectId) pollItem(r, item)
        else generateItem(r, item)
      }
    }
  }

  const dispose = () => {
    disposed = true
    if (persistTimer) {
      clearTimeout(persistTimer)
      ctx.storage.set('reviews', [...reviews.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP_REVIEWS)).catch(() => {})
    }
    for (const set of waiters.values()) for (const fn of [...set]) fn(true)
  }

  return { start, choose, regenerate, autoSelect, finish, cancel, wait, list, get, describe, load, dispose }
}
