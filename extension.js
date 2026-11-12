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
// 결과보고에 붙일 검사 명령. 명령을 && ; | 로 나눈 조각의 맨 앞이 검사 도구일 때만 센다(heredoc 본문 · grep 인자는 빼고)
const CHECKS = [
  ['테스트', /^((npm|pnpm|yarn|bun)\s+(run\s+)?(\S+:)?test\b|npx\s+(vitest|jest|playwright test)\b|(vitest|jest|pytest|cargo test|go test|\.\/gradlew\s+\S*test)\b)/],
  ['린트', /^((npm|pnpm|yarn|bun)\s+(run\s+)?(\S+:)?lint\b|(npx\s+)?(eslint|biome|stylelint|prettier\s+--check)\b)/],
  ['타입 검사', /^((npm|pnpm|yarn|bun)\s+(run\s+)?(\S+:)?(typecheck|type-check)\b|(npx\s+)?tsc\b)/],
  ['빌드', /^((npm|pnpm|yarn|bun)\s+(run\s+)?(\S+:)?build\b|(xcodebuild|swift build|cargo build|go build|\.\/gradlew\s+\S*build)\b|(bash\s+)?\S*build\.sh\b)/],
  ['문법 검사', /^(node --check|python3? -m py_compile)\b/],
]
function checkKinds(cmd) {
  const head = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, '').replace(/\bzsh\s+-l?ic\s+['"]/g, ';')
  const kinds = new Set()
  for (const part of head.split(/&&|\|\||;|\||\n/)) {
    const c = part.trim().replace(/^[(\s]+/, '')
    const hit = CHECKS.find(([, re]) => re.test(c))
    if (hit) kinds.add(hit[0])
  }
  return [...kinds]
}
// 주소 모음: 내 컴퓨터 · 사내망 · 흔한 미리보기 도메인만
const URL_RE = /\bhttps?:\/\/[^\s"'<>`)\]\\]+/g
const PREVIEW_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$|\.(vercel\.app|pages\.dev|workers\.dev|netlify\.app|trycloudflare\.com|ngrok-free\.app|ngrok\.app)$/

let panel
let lastLabel
// 내 화면에서만 쓰는 모듈(local/module.js, git 에 안 올림). 없으면 아무것도 안 한다
let local = null
try { local = require('./local/module.js') } catch {}
const helpers = { uri: p => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(), refresh: () => later() }
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
    if (m.copyImage) copyImage(m.copyImage)
    if (m.local && local && local.onMessage) local.onMessage(m.local, helpers)
    if (m.open) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.open), { viewColumn: vscode.ViewColumn.One, preview: true })
    // 화면이 (다시) 뜨면 지금 자료를 다시 보낸다
    if (m.ready) s ? render() : lastLabel ? select(lastLabel) : post({ empty: 'Claude 세션 탭을 한 번 눌러 주세요.' })
  })
  const page = path.join(__dirname, 'panel.html')
  fs.watchFile(page, { interval: 500 }, () => { if (panel) panel.webview.html = html() })
  panel.onDidDispose(() => { panel = undefined; fs.unwatchFile(page); stop() })
}

// 맥 알림: Cursor 창이 앞에 없을 때만. 처음 기록을 읽는 동안은 알리지 않는다
// ponytail: osascript 알림이라 누르면 Cursor 가 아니라 스크립트 편집기가 열린다. 돌아가기가 필요하면 알림 앱을 따로
function notify(cur, title, text) {
  if (!cur.live || process.platform !== 'darwin' || vscode.window.state.focused) return
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`|>_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
  require('child_process').execFile('osascript', ['-e', 'on run a', '-e', 'display notification (item 2 of a) with title (item 1 of a) sound name "Glass"', '-e', 'end run', 'Claude · ' + title + ' · ' + cur.label, body])
}

// 이미지를 클립보드에 넣는다. ponytail: macOS 만(AppKit). 다른 OS 는 실패로 알림
const COPY_JXA = 'function run(a){ObjC.import("AppKit");const i=$.NSImage.alloc.initWithContentsOfFile(a[0]);if(!i||i.isNil())throw new Error("x");$.NSPasteboard.generalPasteboard.clearContents;return $.NSPasteboard.generalPasteboard.writeObjects($([i]))}'
function copyImage(p) {
  if (process.platform !== 'darwin') return post({ copied: p, ok: false })
  require('child_process').execFile('osascript', ['-l', 'JavaScript', '-e', COPY_JXA, p], err => post({ copied: p, ok: !err }))
}

// 지금 사내망 IP(맥은 en0 먼저). 바뀌어도 그릴 때마다 다시 읽는다
function lanIp() {
  const all = os.networkInterfaces()
  const v4 = list => (list || []).find(a => a.family === 'IPv4' && !a.internal)
  const a = v4(all.en0) || Object.values(all).map(v4).find(Boolean)
  return a ? a.address : ''
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
    ctx: null, cwd: '', agents: new Map(), agentIds: new Map(), files: new Map(), codexCalls: [], urls: new Map(), checkIds: new Map(), codexFiles: new Set(), outputs: [], reports: new Map(), turn: null, msgId: '', msgText: '',
    planFile: path.join(PLANS, id + '.md'),
    usageFile: path.join(USAGE, id + '.json'),
  }
  await readNew(cur)
  if (s !== cur) return
  cur.live = true // 여기부터 새로 생긴 일만 알린다
  render()
  fs.watchFile(cur.file, { interval: 1000 }, () => readNew(cur).then(() => s === cur && render()))
  fs.watchFile(cur.planFile, { interval: 1000 }, () => s === cur && render())
  fs.watchFile(cur.usageFile, { interval: 1000 }, () => s === cur && render())
  fs.watchFile(LIMITS, { interval: 1000 }, () => s === cur && render())
  // 서버가 켜지고 꺼지는 것은 기록에 안 남으니 따로 다시 본다
  cur.liveTimer = setInterval(() => s === cur && cur.urls.size && render(), 15000)
}

function stop() {
  if (!s) return
  fs.unwatchFile(s.file)
  fs.unwatchFile(s.planFile)
  fs.unwatchFile(s.usageFile)
  fs.unwatchFile(LIMITS)
  for (const f of s.codexFiles) fs.unwatchFile(f)
  clearInterval(s.liveTimer)
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
  }).catch(e => console.error('[claude-side-panel] 기록 읽기 실패', e)) // 실패해도 다음 읽기는 이어지게
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
    for (const c of content || []) if (c.type === 'text') { cur.msgText += (cur.msgText ? '\n\n' : '') + c.text; urls(cur, c.text, o.timestamp) }
    if (cur.turn) cur.turn.tools += (content || []).filter(c => c.type === 'tool_use').length
    // 턴을 끝내며 쓴 글이 결과보고다
    if (o.message.stop_reason === 'end_turn' && cur.turn && cur.msgText.trim()) {
      const t = cur.turn
      cur.reports.set(cur.msgId, { id: cur.msgId, at: o.timestamp, ask: t.ask, by: t.by, tools: t.tools, text: cur.msgText, files: [...t.files], shots: [...t.shots], checks: t.checks.slice() })
      t.ended = true
      // 같은 턴에서 보고가 또 나오면 그 뒤에 한 일만 붙도록 비운다
      t.files = new Set(); t.shots = []; t.checks = []
      notify(cur, '일을 마쳤어요', cur.msgText)
    }
    if (u) cur.ctx = { used: u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), model: o.message.model, at: o.timestamp }
    for (const c of content || []) {
      if (c.type !== 'tool_use') continue
      if (c.name === 'Bash') urls(cur, c.input.command || '', o.timestamp)
      // 이 턴에서 한 일: 바꾼 파일 · 캡처 · 검사
      if (cur.turn) {
        const t = cur.turn
        if (EDIT_TOOLS.includes(c.name)) t.files.add(c.input.file_path || c.input.notebook_path)
        if (c.name === 'SendUserFile' && Array.isArray(c.input.files)) c.input.files.filter(f => IMG_RE.test(f)).forEach(f => t.shots.includes(f) || t.shots.push(f))
        if (c.name === 'Read' && IMG_RE.test(c.input.file_path || '') && !t.shots.includes(c.input.file_path)) t.shots.push(c.input.file_path)
        // 한 명령에 여러 검사가 있으면 결과(성공 · 실패)를 같이 쓴다
        const ks = c.name === 'Bash' ? checkKinds(c.input.command || '').map(kind => ({ kind, cmd: c.input.command.split('\n')[0].slice(0, 200), ok: null })) : []
        if (ks.length) { t.checks.push(...ks); cur.checkIds.set(c.id, ks) }
      }
      if (c.name === 'AskUserQuestion') notify(cur, '답을 기다려요', ((c.input.questions || [])[0] || {}).question || '')
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
        // 짝지을 단서: 시각, 작업 폴더 후보, 이어 말하기면 Codex 세션 ID
        const cmd = c.input.command
        cur.codexCalls.push({ t: Date.parse(o.timestamp), dirs: codexDirs(cmd, cur.cwd), id: (cmd.match(/\bresume\s+['"]?([0-9a-f-]{36})/) || [])[1] })
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
        const k = c.type === 'tool_result' && cur.checkIds.get(c.tool_use_id)
        if (k) { k.forEach(x => { x.ok = !c.is_error }); cur.checkIds.delete(c.tool_use_id) }
        const a = c.type === 'tool_result' && cur.agents.get(c.tool_use_id)
        if (!a) continue
        const r = o.toolUseResult || {}
        a.status = c.is_error ? 'failed' : r.status === 'async_launched' ? 'running' : 'done'
        if (r.resolvedModel) a.model = r.resolvedModel
        if (r.agentId) cur.agentIds.set(r.agentId, a)
        a.at = o.timestamp
      }
    }
    const said = typeof content === 'string' ? content : (content || []).map(c => c.text || (c.type === 'tool_result' ? (typeof c.content === 'string' ? c.content : (c.content || []).map(x => x.text || '').join('\n')) : '')).join('\n')
    urls(cur, said, o.timestamp)
    notices(cur, said, o.timestamp)
  } else if (o.type === 'attachment' && o.attachment) {
    // 이어서 시킨 일의 완료 알림은 첨부 줄로도 들어온다
    const p = o.attachment.prompt
    const said = typeof p === 'string' ? p : JSON.stringify(p || '')
    notices(cur, said, o.timestamp)
    // 턴이 끝난 뒤 들어온 에이전트 완료 알림은 새 턴을 연다
    if (said.includes('<task-notification>') && (!cur.turn || cur.turn.ended)) startTurn(cur, said, o.timestamp)
  }
}

// 글 속 미리보기 주소를 모은다. 같은 주소는 마지막으로 나온 때로 옮긴다
function urls(cur, text, at) {
  if (!text.includes('http')) return
  for (const m of text.matchAll(URL_RE)) {
    let u
    try { u = new URL(m[0].replace(/[.,;:!?'"]+$/, '')) } catch { continue }
    if (!PREVIEW_HOST.test(u.hostname)) continue
    const key = u.origin + u.pathname.replace(/\/$/, '') + u.search
    cur.urls.delete(key)
    cur.urls.set(key, { url: key, origin: u.origin, at })
  }
}

// 서버가 켜져 있는지: 아무 응답이든 오면 켜짐. 주소마다 10초에 한 번만 묻는다
const live = new Map()
function checkLive(origins) {
  for (const o of origins) {
    const h = live.get(o)
    if (h && (h.pending || Date.now() - h.at < 10000)) continue
    live.set(o, { ok: h && h.ok, at: Date.now(), pending: true })
    let fin = false
    const done = ok => { if (fin) return; fin = true; live.set(o, { ok, at: Date.now() }); if (!h || h.ok !== ok) later() }
    const req = require(o.startsWith('https') ? 'https' : 'http').request(o, { method: 'HEAD', timeout: 1500, rejectUnauthorized: false }, res => { res.resume(); done(true) })
    req.on('timeout', () => req.destroy())
    req.on('error', () => done(false))
    req.end()
  }
}

// 결과보고 앞에 붙일 「무엇에 대한 보고인지」. 내 요청이면 첫 줄, 에이전트 완료 알림이면 그 요약
function startTurn(cur, said, at) {
  if (/^\s*<(local-command|command-)/.test(said)) return
  const sum = said.match(/<summary>([\s\S]*?)<\/summary>/)
  const by = said.includes('<task-notification>') ? 'agent' : 'me'
  const ask = by === 'agent' ? (sum ? sum[1] : '에이전트 작업 끝남') : said.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').split('\n').map(x => x.trim()).find(Boolean) || ''
  cur.turn = { ask: ask.slice(0, 200), by, tools: 0, at, ended: false, files: new Set(), shots: [], checks: [] }
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

// codex 명령이 돌았을 폴더 후보(-C, cd). 같은 명령에서 정한 변수는 풀고, 못 푼 게 있으면 null(모름)
function codexDirs(cmd, cwd) {
  const vars = Object.fromEntries([...cmd.matchAll(/(?:^|[\s;&])([A-Za-z_]\w*)=(['"]?)([^\s'";&]+)\2/g)].map(m => [m[1], m[3]]))
  const dirs = [...cmd.matchAll(/(?:-C|--cd|\bcd)\s+['"]?([^\s'"&;]+)/g)]
    .map(m => m[1].replace(/\$\{?(\w+)\}?/g, (x, k) => vars[k] ?? x).replace(/^~(?=\/|$)/, os.homedir()))
  if (dirs.some(d => d.includes('$'))) return null
  return dirs.length ? dirs : [cwd]
}

// 이 세션이 시킨 Codex 일: 작업 폴더에 세션 ID 가 있거나, 이어 말하기로 고른 ID 이거나, 호출 뒤 2분 안에 같은 폴더에서 시작한 기록
function codexRuns(cur) {
  const first = Math.min(...cur.codexCalls.map(c => c.t), Date.now())
  const out = []
  for (let day = new Date(first - 864e5); day <= new Date(); day = new Date(+day + 864e5)) {
    const dir = path.join(CODEX, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const p = path.join(dir, n)
      const run = readCodex(p, fs.statSync(p).mtimeMs)
      const mine = (run.cwd || '').includes(cur.id) || cur.codexCalls.some(c => c.id ? c.id === run.id : run.start >= c.t - 2000 && run.start <= c.t + 120000 && (!run.cwd || !c.dirs || c.dirs.includes(run.cwd)))
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

// ponytail: 최근 40개 주소만 보이고 확인한다
function urlList() {
  const list = [...s.urls.values()].reverse().slice(0, 40)
  checkLive(new Set(list.map(u => u.origin)))
  return list.map(u => ({ ...u, live: live.has(u.origin) ? live.get(u.origin).ok : null }))
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
    reports: [...s.reports.values()].reverse().map(r => ({ ...r, html: md(r.text), shots: (r.shots || []).map(p => ({ p, uri: panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(), gone: !fs.existsSync(p) })) })),
    outputs: s.outputs.slice().reverse().map(g => ({ ...g, files: g.files.map(p => ({ p, uri: panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(), gone: !fs.existsSync(p) })) })),
    urls: urlList(),
    local: local && local.data ? local.data(s, helpers) : undefined,
    lanIp: lanIp(),
    agents: [...s.agents.values()].reverse(),
    files: [...s.files.entries()].reverse().map(([p, f]) => ({ p, ...f })),
  })
}

// 화면은 panel.html 에 있다. 열 때마다 새로 읽으므로 고치면 바로 반영된다
function html() {
  const page = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8')
  return local && local.html ? page.replace('</body>', () => local.html(helpers) + '</body>') : page
}

module.exports = { activate, deactivate }
