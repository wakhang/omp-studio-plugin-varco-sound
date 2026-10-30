// VARCO Sound panel: generate from a prompt, list projects, audition takes, save WAVs,
// and review AI-requested batches item by item ("this sound is for X — listen and pick").

const VIEW_ID = 'sounds'
const OPEN = new Set(['generating', 'reviewing', 'saving'])

const TEMPLATE = `
<header class="vs-head">
  <div class="vs-account"></div>
  <div class="vs-head-actions">
    <button type="button" data-act="review" class="vs-review-btn" title="AI가 요청한 사운드 선택 검토">검토</button>
    <button type="button" data-act="folder" title="저장 폴더 열기">폴더</button>
    <button type="button" data-act="refresh" title="새로고침">↻</button>
  </div>
</header>
<form class="vs-gen">
  <textarea class="vs-prompt" rows="2" placeholder="만들 사운드를 설명하세요 (영어 권장) — 예: Short magical coin pickup chime"></textarea>
  <div class="vs-gen-row">
    <label class="vs-check"><input type="checkbox" class="vs-music"> 음악 포함</label>
    <input class="vs-filter" type="search" placeholder="목록 검색…">
    <button type="submit" class="vs-primary">생성</button>
  </div>
</form>
<div class="vs-list"></div>
<div class="vs-review" tabindex="0"></div>`

const errText = (e) => String((e && e.message) || e)
const fmtTime = (iso) => {
  const s = String(iso || '').replace(/(\.\d{3})\d+/, '$1')
  const d = new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z')
  return isNaN(d) ? '' : d.toLocaleString('sv-SE').slice(0, 16)
}
const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
const button = (text, cls, onClick, title) => {
  const b = el('button', cls || '', text)
  b.type = 'button'
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}

let viewers = new Set()
let pendingReview = null

export function activate(ctx) {
  viewers = new Set()
  pendingReview = null
  const openView = () => ctx.ui.openView(`${ctx.pluginId}.view.${VIEW_ID}`)
  ctx.registerView({ id: VIEW_ID, title: 'VARCO Sound', icon: '🔊', mount: (host) => mount(ctx, host, false) })
  ctx.registerPanel({ id: 'vs.panel', title: '사운드', location: 'right', mount: (host) => mount(ctx, host, true) })
  ctx.registerCommand({ id: 'vs.open', title: 'VARCO Sound 열기', run: openView })
  ctx.channel.on('vs.show', openView)
  ctx.channel.on('vs.reviewOpen', (p) => {
    const id = p && p.id
    const full = [...viewers].filter((v) => !v.compact)
    if (full.length) full.forEach((v) => v.openReview(id))
    else {
      pendingReview = id
      openView()
    }
    viewers.forEach((v) => v.compact && v.openReview(id))
  })
}

export function deactivate() {
  viewers = new Set()
  pendingReview = null
}

function mount(ctx, host, compact) {
  const root = el('div', 'vs-root' + (compact ? ' vs-compact' : ''))
  root.innerHTML = TEMPLATE
  host.replaceChildren(root)
  const $ = (s) => root.querySelector(s)
  const listEl = $('.vs-list')
  const reviewEl = $('.vs-review')
  const accountEl = $('.vs-account')
  const promptEl = $('.vs-prompt')
  const musicEl = $('.vs-music')
  const filterEl = $('.vs-filter')
  const genBtn = $('.vs-primary')
  const reviewBtn = $('.vs-review-btn')

  let projects = []
  let reviews = []
  let mode = 'list' // 'list' | 'review'
  let reviewId = null
  const position = new Map() // reviewId -> item index
  let lastPlayed = null // { key, fileId }
  let disposed = false
  let pollTimer = null
  let refreshTimer = null
  let reviewTimer = null
  let seq = 0

  // ---------- playback (Web Audio: the app CSP blocks blob:/data: media sources) ----------
  const buffers = new Map() // fileId -> AudioBuffer
  const decoding = new Map() // fileId -> Promise<AudioBuffer>
  let actx = null
  let current = null
  let playing = null

  const setPlayingUi = () => {
    for (const b of root.querySelectorAll('[data-file]')) b.classList.toggle('playing', b.dataset.file === playing)
  }
  const stop = () => {
    if (current) {
      current.source.onended = null
      try {
        current.source.stop()
      } catch {
        // already stopped
      }
      current = null
    }
    playing = null
    setPlayingUi()
  }
  const audioCtx = () => {
    if (!actx) actx = new AudioContext()
    return actx
  }
  const loadBuffer = (projectId, fileId) => {
    if (buffers.has(fileId)) return Promise.resolve(buffers.get(fileId))
    if (decoding.has(fileId)) return decoding.get(fileId)
    const job = (async () => {
      const r = await ctx.channel.invoke('vs.preview', { projectId, fileId })
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))
      const buf = await audioCtx().decodeAudioData(bytes.buffer)
      buffers.set(fileId, buf)
      if (buffers.size > 60) buffers.delete(buffers.keys().next().value)
      return buf
    })().finally(() => decoding.delete(fileId))
    decoding.set(fileId, job)
    return job
  }
  const play = async (projectId, fileId, btn) => {
    if (playing === fileId) {
      stop()
      return
    }
    try {
      if (btn) btn.classList.add('loading')
      const ac = audioCtx()
      if (ac.state === 'suspended') await ac.resume()
      const buf = await loadBuffer(projectId, fileId)
      if (disposed) return
      stop()
      const source = ac.createBufferSource()
      source.buffer = buf
      source.connect(ac.destination)
      source.onended = () => {
        if (current && current.source === source) stop()
      }
      source.start()
      current = { fileId, source }
      playing = fileId
      setPlayingUi()
    } catch (e) {
      ctx.ui.toast('error', '재생 실패: ' + errText(e))
    } finally {
      if (btn) btn.classList.remove('loading')
    }
  }

  // ---------- account / list ----------
  const renderAccount = (s) => {
    accountEl.replaceChildren()
    if (s.loggedIn) accountEl.append(el('span', 'vs-dot ok'), el('span', 'vs-email', `${s.email} · ${s.tier}`))
    else accountEl.append(el('span', 'vs-dot'), button('VARCO 로그인', 'vs-primary', () => ctx.channel.invoke('vs.login')))
  }

  const renderList = () => {
    const q = filterEl.value.trim().toLowerCase()
    const items = projects.filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        String(p.prompt || '').toLowerCase().includes(q) ||
        p.tracks.some((t) => t.name.toLowerCase().includes(q) || t.candidates.some((c) => String(c.prompt || '').toLowerCase().includes(q)))
    )
    if (!items.length) {
      listEl.replaceChildren(el('div', 'vs-empty', projects.length ? '검색 결과가 없습니다.' : '아직 생성한 사운드가 없습니다. 위에서 생성하거나 에이전트에게 요청하세요.'))
      return
    }
    listEl.replaceChildren(
      ...items.map((p) => {
        const card = el('section', 'vs-card')
        const head = el('div', 'vs-card-head')
        const status = el('span', `vs-status s-${p.status}`, p.status === 'completed' ? '완료' : p.status === 'processing' ? '생성 중…' : p.status)
        const actions = el('div', 'vs-card-actions')
        if (p.status === 'completed') {
          const save = button(
            '저장',
            '',
            async () => {
              save.disabled = true
              try {
                const r = await ctx.channel.invoke('vs.save', { projectId: p.id })
                ctx.ui.toast('info', `${r.saved.length}개 저장: ${r.dir}`)
                ctx.channel.invoke('vs.openFolder', { dir: r.dir })
              } catch (e) {
                ctx.ui.toast('error', errText(e))
              } finally {
                save.disabled = false
              }
            },
            '모든 후보를 WAV로 저장'
          )
          actions.append(save)
        }
        actions.append(button('웹', '', () => ctx.channel.invoke('vs.openWeb', { projectId: p.id }), 'VARCO Sound 웹 편집기에서 열기'))
        head.append(el('div', 'vs-card-title', p.name), status, actions)
        card.append(head, el('div', 'vs-card-meta', fmtTime(p.createdAt) + (p.withMusic ? ' · 음악 포함' : '')))
        if (p.prompt) card.append(el('div', 'vs-prompt-text', p.prompt))
        for (const t of p.tracks) {
          const row = el('div', 'vs-track')
          const info = el('div', 'vs-track-info')
          info.append(el('span', 'vs-track-name', t.name))
          if (t.category) info.append(el('span', 'vs-tag', t.category))
          if (t.duration) info.append(el('span', 'vs-dur', `${t.duration.toFixed(1)}s`))
          const takes = el('div', 'vs-takes')
          t.candidates.forEach((c, k) => {
            const b = button(`▶ ${k + 1}`, 'vs-take' + (c.id === t.selectedFileId ? ' selected' : ''), () => play(p.id, c.id, b))
            b.dataset.file = c.id
            b.title = `${c.name}${c.prompt ? `\n${c.prompt}` : ''}${c.tags && c.tags.length ? `\n#${c.tags.join(' #')}` : ''}`
            takes.append(b)
          })
          row.append(info, takes)
          if (t.candidates[0] && t.candidates[0].prompt) row.append(el('div', 'vs-track-prompt', t.candidates[0].prompt))
          card.append(row)
        }
        return card
      })
    )
    setPlayingUi()
  }

  // ---------- review ----------
  const activeReview = () => reviews.find((r) => r.id === reviewId) || null
  const openReviews = () => reviews.filter((r) => OPEN.has(r.status))
  const decided = (i) => i.choice != null
  const call = async (method, payload) => {
    try {
      return await ctx.channel.invoke(method, payload)
    } catch (e) {
      ctx.ui.toast('error', errText(e))
      return null
    }
  }

  const setMode = (m) => {
    mode = m
    root.classList.toggle('vs-mode-review', m === 'review')
    if (m === 'review') {
      renderReview()
      reviewEl.focus({ preventScroll: true })
    } else {
      stop()
      renderList()
    }
  }

  const goTo = (r, index, autoplay) => {
    const n = Math.max(0, Math.min(r.items.length - 1, index))
    const changedItem = position.get(r.id) !== n
    position.set(r.id, n)
    renderReview()
    const item = r.items[n]
    if (item && item.status === 'ready') {
      for (const c of item.candidates) loadBuffer(item.projectId, c.fileId).then(updateDurations, () => {})
      if (autoplay && changedItem && !decided(item) && item.candidates[0]) {
        lastPlayed = { key: item.key, fileId: item.candidates[0].fileId }
        play(item.projectId, item.candidates[0].fileId)
      }
    }
  }
  const nextUndecided = (r, from) => {
    for (let k = 1; k <= r.items.length; k++) {
      const idx = (from + k) % r.items.length
      if (!decided(r.items[idx]) && r.items[idx].status !== 'failed') return idx
    }
    return -1
  }
  const updateDurations = () => {
    for (const s of reviewEl.querySelectorAll('[data-dur]')) {
      const b = buffers.get(s.dataset.dur)
      if (b) s.textContent = `${b.duration.toFixed(2)}s`
    }
  }

  const choose = async (r, item, fileId) => {
    stop()
    const res = await call('vs.review.choose', { id: r.id, key: item.key, fileId })
    if (!res) return
    replaceReview(res)
    const idx = r.items.indexOf(item)
    const next = nextUndecided(res, idx)
    if (next >= 0) goTo(res, next, true)
    else renderReview()
  }

  const replaceReview = (r) => {
    const k = reviews.findIndex((x) => x.id === r.id)
    if (k >= 0) reviews[k] = r
    else reviews.unshift(r)
    updateReviewBadge()
  }

  const updateReviewBadge = () => {
    const n = openReviews().length
    reviewBtn.textContent = n ? `검토 ${n}` : '검토'
    reviewBtn.classList.toggle('vs-attn', n > 0)
  }

  const renderReviewPicker = () => {
    const box = el('div', 'vs-rv-picker')
    box.append(el('div', 'vs-rv-picker-title', '사운드 선택 검토'))
    if (!reviews.length) box.append(el('div', 'vs-empty', 'AI가 여러 사운드를 요청하면(varco_sound_batch) 여기서 하나씩 듣고 고를 수 있습니다.'))
    for (const r of reviews.slice(0, 20)) {
      const row = el('div', 'vs-rv-pick')
      const n = r.items.filter(decided).length
      row.append(el('span', `vs-status s-${r.status}`, statusLabel(r.status)), el('span', 'vs-rv-pick-title', r.title), el('span', 'vs-dur', `${n}/${r.items.length} · ${new Date(r.createdAt).toLocaleString('sv-SE').slice(0, 16)}`))
      row.addEventListener('click', () => {
        reviewId = r.id
        goTo(r, position.has(r.id) ? position.get(r.id) : Math.max(0, nextUndecided(r, -1)), true)
      })
      box.append(row)
    }
    box.append(button('목록으로', '', () => setMode('list')))
    reviewEl.replaceChildren(box)
  }

  const statusLabel = (s) => ({ generating: '생성 중', reviewing: '선택 대기', saving: '저장 중', done: '완료', cancelled: '취소됨' })[s] || s

  const renderReview = () => {
    if (mode !== 'review') return
    const r = activeReview()
    if (!r) return renderReviewPicker()
    const idx = Math.min(position.get(r.id) || 0, r.items.length - 1)
    const item = r.items[idx]
    const nDecided = r.items.filter(decided).length
    const nGen = r.items.filter((i) => i.status === 'generating').length
    const open = OPEN.has(r.status)
    const editable = r.status === 'generating' || r.status === 'reviewing'

    const head = el('div', 'vs-rv-head')
    const titles = el('div', 'vs-rv-titles')
    titles.append(el('div', 'vs-rv-title', r.title), el('div', 'vs-rv-sub', `${statusLabel(r.status)} · ${nDecided}/${r.items.length} 선택${nGen ? ` · ${nGen}개 생성 중` : ''}${r.finishWhenReady && open ? ' · 생성이 끝나면 자동 저장' : ''}`))
    const actions = el('div', 'vs-rv-actions')
    if (editable) {
      actions.append(
        button('남은 항목 자동선택', '', async () => {
          const res = await call('vs.review.autoSelect', { id: r.id })
          if (res) replaceReview(res), renderReview()
        }, '아직 고르지 않은 항목은 서비스 추천 후보(1번)로 채웁니다'),
        button('전체 자동선택 후 저장', 'vs-primary', async () => {
          stop()
          const res = await call('vs.review.autoSelect', { id: r.id, finish: true })
          if (res) replaceReview(res), renderReview()
        }, '남은 항목을 모두 추천 후보로 정하고 바로 저장합니다')
      )
    }
    actions.append(button('검토 목록', '', () => ((reviewId = null), renderReview())), button('사운드 목록', '', () => setMode('list')))
    head.append(titles, actions)

    const steps = el('div', 'vs-rv-steps')
    r.items.forEach((it, k) => {
      const chip = button(
        `${k + 1}. ${it.title}`,
        'vs-rv-step' +
          (k === idx ? ' current' : '') +
          (it.status === 'generating' ? ' gen' : it.status === 'failed' ? ' failed' : it.choice === 'skip' ? ' skipped' : it.choice ? ' chosen' : ''),
        () => goTo(r, k, true),
        it.purpose
      )
      steps.append(chip)
    })

    const body = el('div', 'vs-rv-body')
    if (!open) body.append(renderResult(r))
    else if (item) body.append(renderItem(r, item, idx, editable))

    const footer = el('div', 'vs-rv-footer')
    if (editable && nDecided === r.items.length && !nGen) {
      footer.append(
        el('span', 'vs-rv-ready', '모든 항목을 골랐습니다.'),
        button('저장하고 완료', 'vs-primary', async () => {
          stop()
          const res = await call('vs.review.finish', { id: r.id })
          if (res) replaceReview(res), renderReview()
        })
      )
    }
    if (editable) {
      footer.append(
        button('검토 취소', 'vs-danger', async () => {
          if (!(await ctx.ui.confirm({ title: '검토 취소', message: `"${r.title}" 검토를 취소할까요? 아무 파일도 저장되지 않습니다.`, confirmLabel: '취소하기' }))) return
          const res = await call('vs.review.cancel', { id: r.id })
          if (res) replaceReview(res), renderReview()
        })
      )
    }
    reviewEl.replaceChildren(head, steps, body, footer)
    setPlayingUi()
    updateDurations()
  }

  const renderItem = (r, item, idx, editable) => {
    const box = el('section', 'vs-rv-item')
    box.append(el('div', 'vs-rv-count', `${idx + 1} / ${r.items.length}`), el('h2', 'vs-rv-name', item.title))
    if (item.purpose) {
      const p = el('div', 'vs-rv-purpose')
      p.append(el('span', 'vs-rv-label', '사용 위치'), el('span', '', item.purpose))
      box.append(p)
    }
    const meta = el('div', 'vs-rv-meta', `프롬프트: ${item.prompt}`)
    box.append(meta)
    if (item.fileName || item.key) box.append(el('div', 'vs-rv-meta', `저장 이름: ${item.fileName || item.key + '.wav'}`))

    if (item.status === 'generating') box.append(el('div', 'vs-rv-wait', '생성 중… (보통 10~60초)'))
    else if (item.status === 'failed') box.append(el('div', 'vs-rv-error', `생성 실패: ${item.error || ''}`))
    else {
      const list = el('div', 'vs-rv-cands')
      const multiTrack = new Set(item.candidates.map((c) => c.track)).size > 1
      item.candidates.forEach((c, k) => {
        const row = el('div', 'vs-rv-cand' + (item.choice === c.fileId ? ' chosen' : ''))
        const playBtn = button('▶', 'vs-rv-play', () => {
          lastPlayed = { key: item.key, fileId: c.fileId }
          play(item.projectId, c.fileId, playBtn)
        }, `${k + 1}번 재생 (키 ${k + 1})`)
        playBtn.dataset.file = c.fileId
        const label = el('div', 'vs-rv-cand-label')
        label.append(el('span', 'vs-rv-cand-n', `후보 ${k + 1}`))
        const dur = el('span', 'vs-dur', '')
        dur.dataset.dur = c.fileId
        label.append(dur)
        if (c.fileId === item.recommended) label.append(el('span', 'vs-tag', '추천'))
        if (multiTrack) label.append(el('span', 'vs-dur', c.track))
        if (item.choice === c.fileId) label.append(el('span', 'vs-rv-chosen-mark', '✔ 선택됨'))
        row.append(playBtn, label)
        if (editable) row.append(button(item.choice === c.fileId ? '선택됨' : '이걸로 선택', item.choice === c.fileId ? 'vs-primary' : '', () => choose(r, item, c.fileId)))
        list.append(row)
      })
      box.append(list)
    }

    const nav = el('div', 'vs-rv-nav')
    nav.append(button('◀ 이전', '', () => goTo(r, idx - 1, true)))
    if (editable && item.status !== 'generating') {
      nav.append(
        button('다시 생성', '', async () => {
          const prompt = await ctx.ui.prompt({ title: '다시 생성', message: '프롬프트를 고칠 수 있습니다 (영어 권장).', defaultValue: item.prompt, multiline: true })
          if (prompt == null) return
          stop()
          const res = await call('vs.review.regenerate', { id: r.id, key: item.key, prompt })
          if (res) replaceReview(res), renderReview()
        }, '이 항목의 후보 3개를 새로 만듭니다 (크레딧 사용)')
      )
      nav.append(button(item.choice === 'skip' ? '건너뜀 ✔' : '건너뛰기', item.choice === 'skip' ? 'vs-primary' : '', () => choose(r, item, 'skip'), '이 사운드는 쓰지 않음 (키 S)'))
    }
    nav.append(button('다음 ▶', '', () => goTo(r, idx + 1, true)))
    box.append(nav)
    if (editable) box.append(el('div', 'vs-rv-hint', '단축키: 1·2·3 재생 · Enter 마지막에 들은 후보 선택 · ←/→ 이동 · S 건너뛰기'))
    return box
  }

  const renderResult = (r) => {
    const box = el('section', 'vs-rv-item')
    box.append(el('h2', 'vs-rv-name', r.status === 'done' ? '저장 완료' : r.status === 'cancelled' ? '취소된 검토' : statusLabel(r.status)))
    for (const it of r.items) {
      const row = el('div', 'vs-rv-result')
      const k = it.candidates.findIndex((c) => c.fileId === it.choice)
      row.append(
        el('span', 'vs-rv-result-title', it.title),
        el('span', 'vs-dur', it.status === 'failed' ? `실패: ${it.error}` : it.choice === 'skip' ? '건너뜀' : k >= 0 ? `후보 ${k + 1}${it.savedPath ? ` → ${it.savedPath}` : ''}${it.error ? ` (${it.error})` : ''}` : '선택 안 함')
      )
      if (k >= 0) {
        const b = button('▶', 'vs-rv-play', () => play(it.projectId, it.choice, b))
        b.dataset.file = it.choice
        row.prepend(b)
      }
      box.append(row)
    }
    const saved = r.items.find((i) => i.savedPath)
    if (saved) {
      const dir = saved.savedPath.replace(/[\\/][^\\/]+$/, '')
      box.append(button('저장 폴더 열기', '', () => ctx.channel.invoke('vs.openFolder', { dir })))
    }
    return box
  }

  reviewEl.addEventListener('keydown', (ev) => {
    if (mode !== 'review' || ev.target.closest('input, textarea')) return
    const r = activeReview()
    if (!r || !OPEN.has(r.status)) return
    const idx = position.get(r.id) || 0
    const item = r.items[idx]
    if (/^[1-9]$/.test(ev.key) && item && item.status === 'ready') {
      const c = item.candidates[Number(ev.key) - 1]
      if (c) {
        lastPlayed = { key: item.key, fileId: c.fileId }
        play(item.projectId, c.fileId)
        ev.preventDefault()
      }
    } else if (ev.key === 'Enter' && item && lastPlayed && lastPlayed.key === item.key) {
      choose(r, item, lastPlayed.fileId)
      ev.preventDefault()
    } else if (ev.key === 'ArrowRight') {
      goTo(r, idx + 1, true)
      ev.preventDefault()
    } else if (ev.key === 'ArrowLeft') {
      goTo(r, idx - 1, true)
      ev.preventDefault()
    } else if ((ev.key === 's' || ev.key === 'S') && item && item.status !== 'generating') {
      choose(r, item, 'skip')
      ev.preventDefault()
    }
  })

  const loadReviews = async () => {
    const list = await ctx.channel.invoke('vs.reviews').catch(() => null)
    if (disposed || !list) return
    reviews = list
    updateReviewBadge()
    renderReview()
  }

  const openReview = async (id) => {
    await loadReviews()
    const r = reviews.find((x) => x.id === id)
    reviewId = r ? r.id : null
    mode = 'review'
    root.classList.add('vs-mode-review')
    if (r) goTo(r, position.has(r.id) ? position.get(r.id) : Math.max(0, nextUndecided(r, -1)), true)
    else renderReview()
    reviewEl.focus({ preventScroll: true })
  }

  // ---------- refresh ----------
  const refresh = async () => {
    const my = ++seq
    let s
    try {
      s = await ctx.channel.invoke('vs.state')
    } catch (e) {
      listEl.replaceChildren(el('div', 'vs-empty', 'VARCO Sound에 연결할 수 없습니다: ' + errText(e)))
      return
    }
    if (disposed || my !== seq) return
    renderAccount(s)
    loadReviews()
    if (!s.loggedIn) {
      projects = []
      listEl.replaceChildren(el('div', 'vs-empty', '로그인하면 생성한 사운드 목록이 여기 표시됩니다.'))
      return
    }
    try {
      projects = await ctx.channel.invoke('vs.list')
    } catch (e) {
      if (!disposed) listEl.replaceChildren(el('div', 'vs-empty', '목록을 불러오지 못했습니다: ' + errText(e)))
      return
    }
    if (disposed || my !== seq) return
    if (mode === 'list') renderList()
    clearTimeout(pollTimer)
    if (projects.some((p) => p.status === 'processing')) pollTimer = setTimeout(refresh, 3000)
  }
  const refreshSoon = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(refresh, 150)
  }
  const reviewsSoon = () => {
    clearTimeout(reviewTimer)
    reviewTimer = setTimeout(loadReviews, 100)
  }

  $('.vs-gen').addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const prompt = promptEl.value.trim()
    if (!prompt) return
    genBtn.disabled = true
    try {
      await ctx.channel.invoke('vs.generate', { prompt, withMusic: musicEl.checked })
      promptEl.value = ''
      refreshSoon()
    } catch (e) {
      ctx.ui.toast('error', errText(e))
    } finally {
      genBtn.disabled = false
    }
  })
  promptEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) $('.vs-gen').requestSubmit()
  })
  filterEl.addEventListener('input', renderList)
  $('.vs-head-actions').addEventListener('click', (ev) => {
    const b = ev.target.closest('button')
    if (!b) return
    if (b.dataset.act === 'refresh') refresh()
    else if (b.dataset.act === 'folder') ctx.channel.invoke('vs.openFolder').catch((e) => ctx.ui.toast('error', errText(e)))
    else if (b.dataset.act === 'review') {
      if (mode === 'review') setMode('list')
      else {
        const open = openReviews()[0]
        if (open) openReview(open.id)
        else {
          reviewId = null
          setMode('review')
        }
      }
    }
  })

  const viewer = { compact, openReview }
  viewers.add(viewer)
  const subs = [ctx.channel.on('vs.changed', refreshSoon), ctx.channel.on('vs.auth', refreshSoon), ctx.channel.on('vs.review', reviewsSoon)]
  refresh()
  if (!compact && pendingReview) {
    const id = pendingReview
    pendingReview = null
    openReview(id)
  }

  return () => {
    disposed = true
    viewers.delete(viewer)
    clearTimeout(pollTimer)
    clearTimeout(refreshTimer)
    clearTimeout(reviewTimer)
    for (const s of subs) s.dispose()
    stop()
    if (actx) actx.close()
    buffers.clear()
    host.replaceChildren()
  }
}
