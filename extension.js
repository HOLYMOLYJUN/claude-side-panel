const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PROJECTS = path.join(os.homedir(), '.claude/projects')
const PLANS = path.join(os.homedir(), '.claude/session-plans')
// mod/ 의 session-usage 플러그인이 턴마다 적는다.
const USAGE = path.join(os.homedir(), '.claude/session-usage')
const LIMITS = path.join(USAGE, '_limits.json')
const CODEX = path.join(os.homedir(), '.codex/sessions')
const CODEX_RE = /\bcodex\s+(exec|review)\b/
// 세션 파일은 수 GB까지 커진다. 큰 기록 줄은 JSON 으로 풀지 않고 건너뛴다.
const SKIP = /^\{"type":"(api-request|atis-latch|pr-link|last-prompt|queue-operation|tools-used|file-history|ai-title|agent-name|custom-title)/
const TITLE_RE = /"(?:customTitle|agentName|aiTitle)":"((?:[^"\\]|\\.)*)"/g
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const IMG_RE = /\.(png|jpe?g|gif|webp|avif)$/i

let panel
let lastLabel
let s // 지금 보여 주는 세션

function activate(ctx) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeSidePanel.open', openPanel),
    vscode.window.tabGroups.onDidChangeTabs(onTabs),
    vscode.window.tabGroups.onDidChangeTabGroups(onTabs),
  )
  onTabs()
}

function deactivate() {
  stop()
}

// 마지막으로 누른 Claude 탭을 따라간다. 이 패널을 누를 때는 바꾸지 않는다.
function onTabs() {
  const t = vscode.window.tabGroups.activeTabGroup.activeTab
  if (!t || !(t.input instanceof vscode.TabInputWebview) || !t.input.viewType.includes('claudeVSCodePanel')) return
  if (t.label === lastLabel) return
  lastLabel = t.label
  if (panel) select(lastLabel)
}

function openPanel() {
  if (panel) return panel.reveal(undefined, true)
  panel = vscode.window.createWebviewPanel('claudeSidePanel', 'Claude 진행판',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    // 보낸 이미지가 scratchpad 등 아무 데나 있어서 로컬 파일 전체를 읽게 둔다
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file('/')] })
  panel.webview.html = html()
  panel.webview.onDidReceiveMessage(m => {
    if (m.codexSend) sendCodex(m.codexSend)
    if (m.url) vscode.env.openExternal(vscode.Uri.parse(m.url))
    if (m.open) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.open), { viewColumn: vscode.ViewColumn.One, preview: true })
    // 화면이 (다시) 뜨면 지금 자료를 다시 보낸다
    if (m.ready) s ? render() : lastLabel ? select(lastLabel) : post({ empty: 'Claude 세션 탭을 한 번 눌러 주세요.' })
  })
  const page = path.join(__dirname, 'panel.html')
  fs.watchFile(page, { interval: 500 }, () => { if (panel) panel.webview.html = html() })
  panel.onDidDispose(() => { panel = undefined; fs.unwatchFile(page); stop() })
}

function post(msg) {
  if (panel) panel.webview.postMessage(msg)
}

async function select(label) {
  stop()
  post({ loading: label })
  const file = findSession(label)
  if (!file) return post({ empty: `「${label}」 세션 파일을 찾지 못했어요.` })
  const id = path.basename(file, '.jsonl')
  const cur = s = {
    file, id, label, offset: 0, rest: Buffer.alloc(0), reading: null,
    ctx: null, cwd: '', agents: new Map(), agentIds: new Map(), files: new Map(), codexCalls: [], codexFiles: new Set(), outputs: [], reports: new Map(), turn: null, msgId: '', msgText: '',
    planFile: path.join(PLANS, id + '.md'),
    usageFile: path.join(USAGE, id + '.json'),
  }
  await readNew(cur)
  if (s !== cur) return
  render()
  fs.watchFile(cur.file, { interval: 1000 }, () => readNew(cur).then(() => s === cur && render()))
  fs.watchFile(cur.planFile, { interval: 1000 }, () => s === cur && render())
  fs.watchFile(cur.usageFile, { interval: 1000 }, () => s === cur && render())
  fs.watchFile(LIMITS, { interval: 1000 }, () => s === cur && render())
}

function stop() {
  if (!s) return
  fs.unwatchFile(s.file)
  fs.unwatchFile(s.planFile)
  fs.unwatchFile(s.usageFile)
  fs.unwatchFile(LIMITS)
  for (const f of s.codexFiles) fs.unwatchFile(f)
  s = undefined
}

// ponytail: 최근 14일 파일의 끝 4MB 에서만 제목을 찾는다. 오래 조용한 세션은 못 찾을 수 있음
function findSession(label) {
  const since = Date.now() - 14 * 864e5
  const files = []
  for (const dir of fs.readdirSync(PROJECTS)) {
    const d = path.join(PROJECTS, dir)
    let names
    try { names = fs.readdirSync(d) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const p = path.join(d, n)
      const st = fs.statSync(p)
      if (st.mtimeMs > since) files.push({ p, mtime: st.mtimeMs, size: st.size })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files) {
    const len = Math.min(f.size, 4 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(f.p, 'r')
    fs.readSync(fd, buf, 0, len, f.size - len)
    fs.closeSync(fd)
    for (const m of buf.toString('utf8').matchAll(TITLE_RE)) {
      if (JSON.parse(`"${m[1]}"`) === label) return f.p
    }
  }
}

// 지난번 읽은 곳부터 새로 붙은 줄만 읽는다.
function readNew(cur) {
  cur.reading = (cur.reading || Promise.resolve()).then(async () => {
    const size = fs.statSync(cur.file).size
    if (size <= cur.offset) return
    let rest = cur.rest
    for await (const chunk of fs.createReadStream(cur.file, { start: cur.offset, end: size - 1 })) {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
      let from = 0
      let i
      while ((i = buf.indexOf(10, from)) !== -1) {
        if (!SKIP.test(buf.toString('utf8', from, Math.min(from + 40, i)))) line(cur, buf.toString('utf8', from, i))
        from = i + 1
      }
      rest = buf.subarray(from)
      if (s !== cur) return
    }
    cur.rest = rest
    cur.offset = size
  })
  return cur.reading
}

function line(cur, text) {
  let o
  try { o = JSON.parse(text) } catch { return }
  if (o.isSidechain) return
  if (o.cwd) cur.cwd = o.cwd
  const content = o.message && o.message.content
  if (o.type === 'assistant') {
    const u = o.message.usage
    // 같은 답이 여러 줄로 나뉘어 들어오므로 메시지 ID 별로 글을 이어 붙인다
    if (o.message.id !== cur.msgId) { cur.msgId = o.message.id; cur.msgText = '' }
    for (const c of content || []) if (c.type === 'text') cur.msgText += (cur.msgText ? '\n\n' : '') + c.text
    if (cur.turn) cur.turn.tools += (content || []).filter(c => c.type === 'tool_use').length
    // 턴을 끝내며 쓴 글이 결과보고다
    if (o.message.stop_reason === 'end_turn' && cur.turn && cur.msgText.trim()) {
      cur.reports.set(cur.msgId, { id: cur.msgId, at: o.timestamp, ask: cur.turn.ask, by: cur.turn.by, tools: cur.turn.tools, text: cur.msgText })
      cur.turn.ended = true
    }
    if (u) cur.ctx = { used: u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), model: o.message.model, at: o.timestamp }
    for (const c of content || []) {
      if (c.type !== 'tool_use') continue
      if (c.name === 'Agent') {
        cur.agents.set(c.id, { name: c.input.name || c.input.description || '이름 없음', type: c.input.subagent_type || 'general-purpose', model: c.input.model, status: 'running', at: o.timestamp })
      } else if (EDIT_TOOLS.includes(c.name)) {
        const p = c.input.file_path || c.input.notebook_path
        const f = cur.files.get(p) || { n: 0 }
        f.n++
        f.at = o.timestamp
        cur.files.delete(p)
        cur.files.set(p, f)
      } else if (c.name === 'Bash' && CODEX_RE.test(c.input.command || '')) {
        cur.codexCalls.push(Date.parse(o.timestamp))
      } else if (c.name === 'Read' && IMG_RE.test(c.input.file_path || '')) {
        // Cursor 채팅에서는 보내지 않고 열어 보기만 한다. 3분 안에 연달아 본 것은 한 묶음으로
        const last = cur.outputs[cur.outputs.length - 1], t = Date.parse(o.timestamp)
        if (last && last.viewed && t - Date.parse(last.at) < 3 * 60000) {
          if (!last.files.includes(c.input.file_path)) last.files.push(c.input.file_path)
          last.at = o.timestamp
        } else cur.outputs.push({ files: [c.input.file_path], caption: '', viewed: true, at: o.timestamp })
      } else if (c.name === 'SendUserFile' && Array.isArray(c.input.files)) {
        cur.outputs.push({ files: c.input.files, caption: c.input.caption || '', at: o.timestamp })
      } else if (c.name === 'SendMessage') {
        // 끝난 에이전트에게 메시지를 보내면 다시 일한다
        const a = cur.agentIds.get(c.input.to) || [...cur.agents.values()].find(x => x.name === c.input.to)
        if (a) { a.status = 'running'; a.at = o.timestamp }
      }
    }
  } else if (o.type === 'user') {
    if (!o.isMeta) {
      const said = typeof content === 'string' ? content : (content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
      if (said.trim()) startTurn(cur, said, o.timestamp)
    }
    if (Array.isArray(content)) {
      for (const c of content) {
        const a = c.type === 'tool_result' && cur.agents.get(c.tool_use_id)
        if (!a) continue
        const r = o.toolUseResult || {}
        a.status = c.is_error ? 'failed' : r.status === 'async_launched' ? 'running' : 'done'
        if (r.resolvedModel) a.model = r.resolvedModel
        if (r.agentId) cur.agentIds.set(r.agentId, a)
        a.at = o.timestamp
      }
    }
    notices(cur, typeof content === 'string' ? content : (content || []).map(c => c.text || '').join('\n'), o.timestamp)
  } else if (o.type === 'attachment' && o.attachment) {
    // 이어서 시킨 일의 완료 알림은 첨부 줄로도 들어온다
    const p = o.attachment.prompt
    const said = typeof p === 'string' ? p : JSON.stringify(p || '')
    notices(cur, said, o.timestamp)
    // 턴이 끝난 뒤 들어온 에이전트 완료 알림은 새 턴을 연다
    if (said.includes('<task-notification>') && (!cur.turn || cur.turn.ended)) startTurn(cur, said, o.timestamp)
  }
}

// 결과보고 앞에 붙일 「무엇에 대한 보고인지」. 내 요청이면 첫 줄, 에이전트 완료 알림이면 그 요약
function startTurn(cur, said, at) {
  if (/^\s*<(local-command|command-)/.test(said)) return
  const sum = said.match(/<summary>([\s\S]*?)<\/summary>/)
  const by = said.includes('<task-notification>') ? 'agent' : 'me'
  const ask = by === 'agent' ? (sum ? sum[1] : '에이전트 작업 끝남') : said.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').split('\n').map(x => x.trim()).find(Boolean) || ''
  cur.turn = { ask: ask.slice(0, 200), by, tools: 0, at, ended: false }
}

// 완료 알림은 에이전트 ID(task-id)로 맞춘다. 이어서 시킨 일이면 tool-use-id 가 SendMessage 호출이라 다르다
function notices(cur, text, at) {
  for (const m of text.matchAll(/<task-id>(.*?)<\/task-id>[\s\S]*?<tool-use-id>(.*?)<\/tool-use-id>[\s\S]*?<status>(.*?)<\/status>/g)) {
    const a = cur.agentIds.get(m[1]) || cur.agents.get(m[2])
    if (a) { a.status = m[3] === 'completed' ? 'done' : m[3]; a.at = at }
  }
}

// Codex 기록 하나를 읽는다. 파일이 바뀌지 않았으면 지난번 결과를 쓴다.
const codexCache = new Map()
function readCodex(p, mtimeMs) {
  const hit = codexCache.get(p)
  if (hit && hit.mtimeMs === mtimeMs) return hit.run
  const run = { file: p, id: '', prompt: '', model: '', status: 'running', start: 0, ms: 0, tokens: 0, answer: '', turns: [] }
  let begun = 0
  for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    const q = o.payload || {}
    if (o.type === 'session_meta') { run.start = Date.parse(q.timestamp); run.cwd = q.cwd; run.id = q.id }
    else if (o.type === 'turn_context' && q.model) run.model = q.model
    else if (o.type === 'response_item' && q.type === 'message' && q.role === 'user') {
      // 규칙 파일과 환경 안내, 이미지 표시는 빼고 사람이 쓴 요청만 남긴다
      const t = (q.content || []).filter(c => c.type === 'input_text' && !/^\s*(<|# AGENTS\.md)/.test(c.text)).map(c => c.text).join('\n').trim()
      if (t) {
        if (!run.prompt) run.prompt = t
        run.turns.push({ who: 'me', text: t, at: o.timestamp })
      }
    } else if (o.type === 'event_msg' && q.type === 'token_count' && q.info) run.tokens = q.info.total_token_usage.total_tokens
    else if (o.type === 'event_msg' && q.type === 'task_started') { run.status = 'running'; begun = Date.parse(o.timestamp) }
    else if (o.type === 'event_msg' && q.type === 'task_complete') {
      run.status = 'done'
      run.ms = q.duration_ms
      run.answer = q.last_agent_message || ''
      run.turns.push({ who: 'codex', text: run.answer, at: o.timestamp })
    }
  }
  // ponytail: 끝 기록 없이 10분 넘게 조용하면 멈춘 것으로 본다
  if (run.status === 'running' && Date.now() - mtimeMs > 10 * 60000) run.status = 'stopped'
  if (run.status === 'running') run.ms = Date.now() - (begun || run.start)
  codexCache.set(p, { mtimeMs, run })
  return run
}

// Codex 한도는 계정 단위다. 가장 최근 Codex 기록의 끝에서 마지막 한도 값을 찾는다
let codexLimitCache = null
// 기록마다 어느 계정이 만들었는지(첫 줄) 기억해 둔다
const accountOf = new Map()
function fileAccount(f) {
  if (accountOf.has(f)) return accountOf.get(f)
  let acc = ''
  try {
    const buf = Buffer.alloc(256 * 1024), fd = fs.openSync(f, 'r'), n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    acc = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0]).payload.creator_account_id || ''
  } catch {}
  accountOf.set(f, acc)
  return acc
}

function codexLimits() {
  // 계정을 바꾸면 이전 계정 한도가 보이지 않게, 지금 로그인한 계정이 만든 기록만 본다
  let account = ''
  try { account = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex/auth.json'), 'utf8')).tokens.account_id || '' } catch {}
  const all = []
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.now() - i * 864e5)
    const dir = path.join(CODEX, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')) } catch { continue }
    for (const n of names) { const f = path.join(dir, n); all.push({ f, m: fs.statSync(f).mtimeMs }) }
  }
  all.sort((x, y) => y.m - x.m)
  const newest = all.find(x => !account || fileAccount(x.f) === account)
  if (!newest) return all.length ? { none: true } : null
  if (codexLimitCache && codexLimitCache.f === newest.f && codexLimitCache.m === newest.m) return codexLimitCache.v
  const size = fs.statSync(newest.f).size, len = Math.min(size, 1024 * 1024), buf = Buffer.alloc(len)
  const fd = fs.openSync(newest.f, 'r')
  fs.readSync(fd, buf, 0, len, size - len)
  fs.closeSync(fd)
  let v = null
  for (const l of buf.toString('utf8').split('\n').reverse()) {
    if (!l.includes('"rate_limits"')) continue
    try {
      const o = JSON.parse(l), r = o.payload.rate_limits
      if (r && r.primary) { v = { at: Date.parse(o.timestamp), plan: r.plan_type, windows: [r.primary, r.secondary].filter(Boolean) }; break }
    } catch {}
  }
  codexLimitCache = { ...newest, v }
  return v
}

// 진행판에서 쓴 말을 그 Codex 세션에 이어 보낸다. 처음과 같은 작업 폴더에서 돌린다
function sendCodex({ file, text, write }) {
  const run = codexCache.get(file) && codexCache.get(file).run
  if (!run || !run.id || !text.trim()) return
  const cwd = run.cwd && fs.existsSync(run.cwd) ? run.cwd : os.homedir()
  // mise 로 깐 codex 와 node 를 찾으려면 로그인 셸을 거쳐야 한다. 값은 환경 변수로 넘겨 따옴표 문제를 피한다
  const child = require('child_process').spawn('zsh', ['-ic', 'codex exec resume --skip-git-repo-check -c sandbox_mode="$CX_MODE" "$CX_ID" -'], {
    cwd,
    env: { ...process.env, CX_ID: run.id, CX_MODE: write ? 'workspace-write' : 'read-only' },
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', b => { err = (err + b).slice(-2000) })
  child.on('close', code => { if (code) vscode.window.showErrorMessage('Codex 에 보내지 못했어요: ' + err.trim().split('\n').pop()) })
  child.stdin.end(text)
}

// 이 세션이 시킨 Codex 일: 작업 폴더에 세션 ID 가 있거나, codex exec 호출 뒤 2분 안에 시작한 기록
function codexRuns(cur) {
  const first = Math.min(...cur.codexCalls, Date.now())
  const out = []
  for (let day = new Date(first - 864e5); day <= new Date(); day = new Date(+day + 864e5)) {
    const dir = path.join(CODEX, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const p = path.join(dir, n)
      const run = readCodex(p, fs.statSync(p).mtimeMs)
      const mine = (run.cwd || '').includes(cur.id) || cur.codexCalls.some(t => run.start >= t - 2000 && run.start <= t + 120000)
      if (mine) out.push(run)
    }
  }
  return out.sort((a, b) => b.start - a.start)
}

// Codex 답은 마크다운이다. Cursor 기본 마크다운 변환기로 바꾸고 글 내용별로 기억해 둔다
const mdCache = new Map(), mdPending = new Set()
// 변환이 여러 개 끝나도 다시 그리기는 한 번만
let laterTimer = null
const later = () => { clearTimeout(laterTimer); laterTimer = setTimeout(() => s && render(), 150) }
function md(text) {
  if (mdCache.has(text)) return mdCache.get(text)
  if (!mdPending.has(text)) {
    mdPending.add(text)
    Promise.resolve(vscode.commands.executeCommand('markdown.api.render', text))
      .then(html => { mdCache.set(text, html); later() }, () => mdCache.set(text, null))
      .finally(() => mdPending.delete(text))
  }
  return null
}

function render() {
  const codex = codexRuns(s)
  for (const r of codex) {
    if (s.codexFiles.has(r.file)) continue
    const cur = s
    s.codexFiles.add(r.file)
    fs.watchFile(r.file, { interval: 1000 }, () => s === cur && render())
  }
  let plan = ''
  try { plan = fs.readFileSync(s.planFile, 'utf8') } catch {}
  let usage = null
  try { usage = JSON.parse(fs.readFileSync(s.usageFile, 'utf8')) } catch {}
  // 한도는 계정 단위라 모든 세션이 같은 파일을 본다
  let limits = null
  try { limits = JSON.parse(fs.readFileSync(LIMITS, 'utf8')) } catch {}
  post({
    limits,
    label: s.label,
    sid: s.id,
    cwd: s.cwd,
    plan,
    ctx: s.ctx,
    usage,
    codex: codex.map(r => ({ ...r, turns: r.turns.map(t => t.who === 'codex' ? { ...t, html: md(t.text) } : t) })),
    codexLimits: codexLimits(),
    reports: [...s.reports.values()].reverse().map(r => ({ ...r, html: md(r.text) })),
    outputs: s.outputs.slice().reverse().map(g => ({ ...g, files: g.files.map(p => ({ p, uri: panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(), gone: !fs.existsSync(p) })) })),
    agents: [...s.agents.values()].reverse(),
    files: [...s.files.entries()].reverse().map(([p, f]) => ({ p, ...f })),
  })
}

// 화면은 panel.html 에 있다. 열 때마다 새로 읽으므로 고치면 바로 반영된다
function html() {
  return fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8')
}

module.exports = { activate, deactivate }
