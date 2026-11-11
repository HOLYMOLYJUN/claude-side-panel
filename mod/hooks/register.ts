import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

const dirOf = async ($: EngineInterface) => (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`

// 한도는 계정 단위이고 응답마다 오지 않는다. 받은 값이 있을 때만 공용 파일에 적어 빈 값으로 지워지지 않게 한다.
async function saveLimits($: EngineInterface, limits: SessionRateLimit[]) {
  if (!limits.length) return
  await $.fs.write(`${await dirOf($)}/session-usage/_limits.json`, JSON.stringify({ at: Date.now(), rateLimits: limits }))
}

// 화면은 그리지 않는다. Claude 진행판 확장이 이 파일을 읽어 컨텍스트 탭에 보여 준다.
async function save($: EngineInterface) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const id = await $.session.id()
    await $.fs.write(`${await dirOf($)}/session-usage/${id}.json`, JSON.stringify({
      at: Date.now(),
      context: {
        tokens: u.context.tokens,
        window: u.context.window,
        percent: u.context.percent,
        categories: u.context.breakdown?.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      },
      cost: u.cost?.usd,
    }))
    await saveLimits($, u.rateLimits)
  } catch (err) {
    $.ui.log(`session-usage: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    void save($)
    return r
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) void save($)
    return r
  })
  // 한도가 1포인트 움직일 때마다 온다
  on('session.measure', async ($, e, next) => {
    void saveLimits($, e.rateLimits).catch(() => {})
    return next(e)
  })
}
