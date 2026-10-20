// dsh-skills-hub — Host 半区（v0.3.0）
//
// 本版重写了「技能从哪来、对上下文花多少」的计算方式：
//
//   1. 目录 = 磁盘事实 + 会话事实。
//      DSH 的 skill 插件在 Web 组合里是 **按预设作用域挂载** 的（dsh-base 的
//      全局 skill-filesystem / tool-skill 被 dsh-web-app 关掉），所以从插件
//      的全局上下文调用 ctx.skills 只会拿到空目录。这里改为：
//        · 自己按官方规则扫描技能根（project/.dsh、project/.agents、预设内置、
//          ~/.dsh/skills、~/.agents/skills），解析 frontmatter 并按 rank 去重；
//        · 用当前会话里已发布的 skill-catalog 消息作为「模型实际看到什么」的
//          权威对照，补齐预设层技能并检测目录漂移。
//      若某些部署里全局 ctx.skills 确实有内容，则作为覆盖层合入。
//
//   2. 成本 = 目录行 + 正文。
//      目录行 "- `name`: description"，描述先归一化空白、再按
//      catalogDescriptionMaxLength（tool-skill 配置，默认 500）截断；正文成本
//      来自 SKILL.md 字节数。token 为估算值。
//
//   3. 可操作：写 frontmatter 的 disable-model-invocation 把 skill 从模型目录
//      摘掉（文件保留），这是最直接的上下文减负手段。
//
// 插件不注册任何模型工具 / 技能，自身对上下文的固定占用为 0。

export const name = 'dsh-skills-hub'

const CAP_DEFAULT = 500
const BIG_BODY_BYTES = 12 * 1024
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// 与 dsh-tool-skill 的 renderCatalogMessage 逐字一致（空目录版本），用于固定开销。
const ENVELOPE_LINES = [
  '<system-reminder>',
  'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
  '',
  '<available_skills>',
  '</available_skills>',
  '',
  "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
  'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
  '</system-reminder>',
]
const ENVELOPE_CHARS = ENVELOPE_LINES.join('\n').length

// 已发布过一次之后，DSH 改用 renderCatalogUpdate 的「变更版」框架。
const UPDATE_HEADER = 'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
const UPDATE_AVAILABILITY = [
  'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
  'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
]
const EMPTY_AVAILABILITY = [
  'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
  'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
]

export function apply(ctx) {
  let writePolicy

  const service = (key) => {
    try {
      return ctx.get(key)
    } catch (e) {
      return undefined
    }
  }

  // ---------- HTTP 请求辅助 ----------
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw) return resolve({})
        try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)) }
      })
      req.on('error', reject)
    })
  }

  function jsonRoute(logic) {
    return async (req, res) => {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        const args = await readJsonBody(req)
        const result = await logic(args)
        res.statusCode = 200
        res.end(JSON.stringify(result))
      } catch (err) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 300) }))
      }
    }
  }

  // ---------- 小工具 ----------
  const esc = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const joinPath = (a, b) => (a && b) ? (a.endsWith('/') ? a + b : a + '/' + b) : (a || b)
  const enc = (s) => encodeURIComponent(String(s))

  // 与 dsh-tool-skill 的 catalogDescription 逐字一致。
  const normalizeDescription = (value) => String(value == null ? '' : value).replaceAll(/\s+/g, ' ').trim()

  function applyCap(normalized, cap) {
    return normalized.length <= cap ? normalized : `${normalized.slice(0, Math.max(0, cap - 3))}...`
  }

  const escapeText = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

  // 粗略 token 估算：CJK ≈ 1.1 token/字，其余 ≈ 4 字符/token。
  function estimateTokens(text) {
    const s = String(text == null ? '' : text)
    let cjk = 0
    let other = 0
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) >= 0x2e80) cjk += 1
      else other += 1
    }
    return Math.ceil(other / 4 + cjk * 1.1)
  }

  const catalogLine = (name, description) => `- \`${name}\`: ${description}`

  // skill-filesystem 的布尔文法：true/false、yes/no、on/off、1/0（不区分大小写）。
  function strictBoolean(value) {
    const v = String(value == null ? '' : value).trim().toLowerCase()
    if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true
    if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false
    return null
  }

  // ---------- shell（兼容 0.2.x execute(spec).result() 与更早的 run(spec)） ----------
  async function runShell(script, opts) {
    const shell = service('shell')
    const o = opts || {}
    if (shell === undefined) return { exitCode: -1, stdout: '', stderr: 'shell service unavailable' }
    const request = {
      command: script,
      timeoutMs: o.timeoutMs || 30000,
      stdoutMaxBytes: o.stdoutMaxBytes || 512 * 1024,
    }
    if (o.policy !== undefined) request.sandboxPolicy = o.policy
    try {
      let res
      if (typeof shell.execute === 'function') {
        const spec = shell.resolve(request)
        const execution = await shell.execute(spec)
        res = typeof execution.result === 'function' ? await execution.result() : await execution.result
      } else if (typeof shell.run === 'function') {
        res = await shell.run(shell.resolve(request))
      } else {
        return { exitCode: -1, stdout: '', stderr: 'shell service has neither execute() nor run()' }
      }
      const out = res && res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : ''
      const errTxt = res && res.stderr && typeof res.stderr.text === 'string' ? res.stderr.text : ''
      return { exitCode: res ? res.exitCode : -1, stdout: out, stderr: errTxt }
    } catch (err) {
      return { exitCode: -1, stdout: '', stderr: String((err && err.message) || err) }
    }
  }

  let envCache = null
  async function readEnv() {
    if (envCache !== null) return envCache
    const r = await runShell(
      'printf \'%s\\n\' "${DSH_HOME:-}"; printf \'%s\\n\' "${DSH_AGENTS_HOME:-}"; printf \'%s\\n\' "${DSH_BUNDLED_SKILL_DIR:-}"; printf \'%s\\n\' "${DSH_PROFILE:-}"; printf \'%s\\n\' "${DSH_PROFILE_DIR:-}"; printf \'%s\\n\' "$HOME"',
      { timeoutMs: 10000 },
    )
    const lines = r.exitCode === 0 ? r.stdout.split('\n') : []
    const home = lines[5] || ''
    const dshHome = lines[0] || joinPath(home, '.dsh')
    envCache = {
      home,
      dshHome,
      agentsHome: lines[1] || joinPath(home, '.agents'),
      bundled: lines[2] || '',
      profile: lines[3] || '',
      profileDir: lines[4] || '',
    }
    return envCache
  }

  function workspaceRoot() {
    const sandboxPolicy = service('sandboxPolicy')
    if (sandboxPolicy === undefined) return null
    try { return sandboxPolicy.resolve().workspaceRoot || null } catch (e) { return null }
  }

  const isInsideWorkspace = (p) => {
    const ws = workspaceRoot()
    return Boolean(ws && p && (p === ws || p.indexOf(ws + '/') === 0))
  }

  async function writeTextAt(path, content) {
    const fs = service('fs')
    if (fs === undefined) return { ok: false, error: 'fs 服务不可用' }
    const sandboxPolicy = service('sandboxPolicy')
    const policy = !isInsideWorkspace(path) && sandboxPolicy !== undefined
      ? sandboxPolicy.resolve({ mode: 'danger-full-access' })
      : undefined
    try {
      const target = await fs.resolve(path)
      await fs.writeText(target, content, undefined, undefined, policy)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
    }
  }

  async function readSkillFile(path) {
    const fs = service('fs')
    if (fs === undefined || !path) return null
    try {
      const target = await fs.resolve(path)
      const text = await fs.readText(target)
      return typeof text === 'string' ? text : null
    } catch (e) {
      return null
    }
  }

  // ---------- frontmatter ----------
  // 只解析 skill frontmatter 需要的 YAML 子集：标量、引号、行内注释、> / | 块标量。
  function parseFrontmatter(text) {
    const src = String(text || '')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
    if (!m) return { has: false }
    const lines = m[1].split(/\r?\n/)
    const out = {}
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim() || line.trim().startsWith('#')) continue
      const kv = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line)
      if (!kv) continue
      const key = kv[1]
      let value = (kv[2] || '').trim()
      if (value === '>' || value === '>-' || value === '|' || value === '|-') {
        const folded = value[0] === '>'
        const chunks = []
        let j = i + 1
        while (j < lines.length) {
          const next = lines[j]
          if (next.trim() === '') { chunks.push(''); j += 1; continue }
          if (!/^\s+/.test(next)) break
          chunks.push(next.replace(/^\s+/, ''))
          j += 1
        }
        i = j - 1
        const text2 = folded
          ? chunks.join(' ').replace(/\s+/g, ' ').trim()
          : chunks.join('\n').trim()
        out[key] = text2
        continue
      }
      value = value.replace(/\s+#.*$/, '')
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1)
      }
      out[key] = value
    }
    return {
      has: true,
      name: out.name || '',
      description: out.description || '',
      disableModelInvocation: out['disable-model-invocation'] === undefined ? null : out['disable-model-invocation'],
      userInvocable: out['user-invocable'] === undefined ? null : out['user-invocable'],
    }
  }

  // 在 frontmatter 中启用/移除 disable-model-invocation，其余内容逐字保留。
  function withModelInvocation(text, enabled) {
    const src = String(text || '')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
    if (!m) return { error: '该文件没有 YAML frontmatter，无法切换模型可见性' }
    const lines = m[1].split(/\r?\n/)
    const idx = lines.findIndex((line) => /^disable-model-invocation\s*:/.test(line))
    if (enabled) {
      if (idx !== -1) lines.splice(idx, 1)
    } else if (idx !== -1) {
      lines[idx] = 'disable-model-invocation: true'
    } else {
      lines.push('disable-model-invocation: true')
    }
    const rest = src.slice(m[0].length)
    const head = `---\n${lines.join('\n')}\n---`
    const body = rest.startsWith('\r\n') ? rest.slice(2) : rest.startsWith('\n') ? rest.slice(1) : rest
    return { text: `${head}\n${body}` }
  }

  // ---------- 技能根 ----------
  function rootList(env, projectRoot) {
    const roots = []
    const add = (path, kind, rank) => {
      if (!path) return
      if (roots.some((r) => r.path === path)) return
      roots.push({ path, kind, rank })
    }
    if (projectRoot) add(joinPath(projectRoot, '.dsh/skills'), 'project', 100)
    if (projectRoot) add(joinPath(projectRoot, '.agents/skills'), 'project-agents', 200)
    const ws = workspaceRoot()
    if (ws) add(joinPath(ws, '.dsh/skills'), 'project', 100)
    add(joinPath(env.dshHome, 'skills'), 'user', 400)
    add(joinPath(env.agentsHome, 'skills'), 'agents', 500)
    if (env.bundled) add(env.bundled, 'bundled', 600)
    return roots
  }

  function buildScanScript(roots, env) {
    const calls = roots.map((r) => `hub_scan ${esc(r.path)} ${esc(r.kind)} ${r.rank}`).join('\n')
    const bin = typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv[1] ? String(process.argv[1]) : ''
    return `
hub_scan() {
  root="$1"; kind="$2"; rank="$3"
  [ -d "$root" ] || return 0
  root=$(readlink -f "$root" 2>/dev/null || printf '%s' "$root")
  printf 'ROOT\\t%s\\t%s\\t%s\\n' "$root" "$kind" "$rank"
  for d in "$root"/*; do
    [ -e "$d" ] || [ -L "$d" ] || continue
    n=$(basename "$d")
    if [ -L "$d" ] || [ -d "$d" ]; then
      real=$(readlink -f "$d" 2>/dev/null || printf '%s' "$d")
      link=$(readlink "$d" 2>/dev/null || true)
      ex=0; sz=0
      if [ -f "$d/SKILL.md" ]; then
        ex=1
        sz=$(wc -c < "$d/SKILL.md" 2>/dev/null | tr -d ' ')
      fi
      printf 'DIR\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$n" "$real" "$link" "$root" "\${sz:-0}" "$ex" "$kind"
      find -L "$d" -maxdepth 4 -type f -name '*.md' 2>/dev/null | sort | while IFS= read -r f; do
        case "$f" in
          "$d"/*) rel=\${f#"$d"/} ;;
          *) rel=\${f##*/} ;;
        esac
        printf 'FILE\\t%s\\t%s\\n' "$n" "$rel"
      done
    elif [ -f "$d" ] && [ "\${d##*.}" = "md" ]; then
      sz=$(wc -c < "$d" 2>/dev/null | tr -d ' ')
      printf 'FLAT\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(basename "$d" .md)" "$(readlink -f "$d" 2>/dev/null || printf '%s' "$d")" "$root" "\${sz:-0}" "$kind"
    fi
  done
}
bin=${esc(bin)}
if [ -n "$bin" ]; then
  realbin=$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")
  bdir=$(dirname "$realbin")
  for cand in "$bdir/../node_modules/@deepseek-ai/dsh-agent-preset/skills" "$bdir/../lib/node_modules/@deepseek-ai/dsh-agent-preset/skills"; do
    if [ -d "$cand" ]; then hub_scan "$cand" preset 300; fi
  done
fi
for pdir in ${env.dshHome}/plugins/*/skills; do
  if [ -d "$pdir" ]; then hub_scan "$pdir" plugin 300; fi
done
for pdir in ${env.dshHome}/.agent-presets/*/skills; do
  if [ -d "$pdir" ]; then hub_scan "$pdir" preset 290; fi
done
${calls}
`
  }

  async function scanRoots(roots, env) {
    const r = await runShell(buildScanScript(roots, env), { timeoutMs: 45000 })
    const occurrences = []
    const rootsSeen = []
    let current = null
    if (r.exitCode !== 0) return { occurrences, rootsSeen, error: String(r.stderr || '扫描失败').slice(0, 200) }
    for (const line of r.stdout.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      if (parts[0] === 'ROOT' && parts[1]) {
        if (rootsSeen.indexOf(parts[1]) === -1) rootsSeen.push(parts[1])
      } else if (parts[0] === 'DIR' && parts[1]) {
        const root = parts[4] || ''
        current = {
          kind: parts[7] || 'other',
          dirName: parts[1],
          dir: joinPath(root, parts[1]),
          realDir: parts[2] || joinPath(root, parts[1]),
          link: parts[3] || '',
          root,
          bytes: Number(parts[5] || 0) || 0,
          hasEntry: parts[6] === '1',
          entryFile: joinPath(joinPath(root, parts[1]), 'SKILL.md'),
          files: [],
          flat: false,
        }
        occurrences.push(current)
      } else if (parts[0] === 'FILE' && parts[1] && parts[2]) {
        if (current && current.dirName === parts[1] && current.files.indexOf(parts[2]) === -1) current.files.push(parts[2])
      } else if (parts[0] === 'FLAT' && parts[1]) {
        const root = parts[3] || ''
        current = {
          kind: parts[5] || 'other',
          dirName: parts[1],
          dir: null,
          realDir: null,
          link: '',
          root,
          bytes: Number(parts[4] || 0) || 0,
          hasEntry: true,
          entryFile: joinPath(root, parts[1] + '.md'),
          files: [parts[1] + '.md'],
          flat: true,
        }
        occurrences.push(current)
      }
    }
    return { occurrences, rootsSeen, error: null }
  }

  const RANK_OF = { project: 100, 'project-agents': 200, preset: 290, plugin: 300, user: 400, agents: 500, bundled: 600, other: 900 }
  // 只有这些来源归用户所有，可以安全改写 frontmatter / 删除。
  const WRITABLE = new Set(['project', 'project-agents', 'user', 'agents'])

  // 逐条读 frontmatter，按 DSH 的规则校验；无效项单独留作诊断。
  async function inspectOccurrences(occurrences) {
    const valid = []
    const invalid = []
    for (const occ of occurrences) {
      if (!occ.hasEntry) {
        invalid.push({ name: occ.dirName, reason: 'missing-entry', detail: '目录内没有 SKILL.md，DSH 不会发现它', path: occ.entryFile, source: occ.kind })
        continue
      }
      const text = await readSkillFile(occ.entryFile)
      if (text === null) {
        invalid.push({ name: occ.dirName, reason: 'unreadable', detail: '无法读取指令文件', path: occ.entryFile, source: occ.kind })
        continue
      }
      const fm = parseFrontmatter(text)
      if (!fm.has) {
        invalid.push({ name: occ.dirName, reason: 'invalid', detail: '缺少 YAML frontmatter，DSH 会静默跳过', path: occ.entryFile, source: occ.kind })
        continue
      }
      if (!SKILL_NAME.test(fm.name)) {
        invalid.push({
          name: fm.name || occ.dirName,
          reason: 'invalid',
          detail: fm.name ? `name "${fm.name}" 不是 kebab-case，DSH 会静默跳过` : 'frontmatter 缺少 name',
          path: occ.entryFile,
          source: occ.kind,
        })
        continue
      }
      if (!fm.description) {
        invalid.push({ name: fm.name, reason: 'invalid', detail: 'frontmatter 缺少 description，DSH 会静默跳过', path: occ.entryFile, source: occ.kind })
        continue
      }
      const disabled = fm.disableModelInvocation === null ? null : strictBoolean(fm.disableModelInvocation)
      if (fm.disableModelInvocation !== null && disabled === null) {
        invalid.push({ name: fm.name, reason: 'invalid', detail: `disable-model-invocation 取值 "${fm.disableModelInvocation}" 非法，DSH 会丢弃整个 skill`, path: occ.entryFile, source: occ.kind })
        continue
      }
      const userInvocable = fm.userInvocable === null ? null : strictBoolean(fm.userInvocable)
      if (fm.userInvocable !== null && userInvocable === null) {
        invalid.push({ name: fm.name, reason: 'invalid', detail: `user-invocable 取值 "${fm.userInvocable}" 非法，DSH 会丢弃整个 skill`, path: occ.entryFile, source: occ.kind })
        continue
      }
      valid.push({
        name: fm.name,
        description: fm.description,
        modelInvocable: disabled !== true,
        userInvocable: userInvocable !== false,
        rank: RANK_OF[occ.kind] || 900,
        occ,
      })
    }
    return { valid, invalid }
  }

  function groupWinners(valid) {
    const groups = new Map()
    for (const item of valid) {
      const list = groups.get(item.name) || []
      list.push(item)
      groups.set(item.name, list)
    }
    for (const list of groups.values()) list.sort((a, b) => a.rank - b.rank)
    return groups
  }

  // ---------- 可选：全局注册表（多数 Web 部署里为空） ----------
  async function readRegistryCatalog(cwd) {
    const skills = service('skills')
    if (skills === undefined || typeof skills.snapshot !== 'function') return { available: false, skills: [] }
    try {
      const snap = await skills.snapshot({ cwd: cwd || undefined })
      const list = Array.isArray(snap && snap.skills) ? snap.skills : []
      return { available: true, complete: snap.complete !== false, skills: list }
    } catch (err) {
      return { available: true, skills: [], error: String((err && err.message) || err).slice(0, 200) }
    }
  }

  const SOURCE_OF_REGISTRY = {
    'project-dsh': 'project',
    'project-agents': 'project-agents',
    'user-dsh': 'user',
    'user-agents': 'agents',
    bundled: 'bundled',
    runtime: 'runtime',
    custom: 'preset',
  }

  // ---------- 会话已发布的目录 ----------
  function findSession(args) {
    const store = service('sessions')
    let id = args && typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : null
    if (!id) {
      const agents = service('agents')
      try {
        const init = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
        if (init && init.session && typeof init.session.id === 'string') id = init.session.id
      } catch (e) { /* ignore */ }
    }
    if (!id) return { id: null, session: null }
    if (store !== undefined && typeof store.get === 'function') {
      try {
        const session = store.get(id)
        if (session) return { id, session }
      } catch (e) { /* ignore */ }
    }
    return { id, session: null }
  }

  function messageText(message) {
    const blocks = message && message.content
    if (!Array.isArray(blocks)) return ''
    let text = ''
    for (const block of blocks) {
      if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    }
    return text
  }

  function readSessionCatalog(args) {
    const found = findSession(args)
    const empty = { found: false, id: found.id, published: false, publishes: 0, chars: 0, tokens: 0, historyChars: 0, historyTokens: 0, entries: [], preview: '' }
    if (!found.session) return empty
    let messages
    try {
      messages = found.session.deriveMessages()
    } catch (err) {
      return Object.assign({}, empty, { found: true, error: String((err && err.message) || err).slice(0, 200) })
    }
    const catalogs = []
    let historyChars = 0
    let historyTokens = 0
    for (const message of messages) {
      const source = message && message.source
      if (!source || source.kind !== 'skill-catalog') continue
      catalogs.push(message)
      const text = messageText(message)
      historyChars += text.length
      historyTokens += estimateTokens(text)
    }
    if (catalogs.length === 0) return Object.assign({}, empty, { found: true })
    const last = catalogs[catalogs.length - 1]
    const text = messageText(last)
    const entries = Array.isArray(last.source.entries)
      ? last.source.entries.map((e) => ({ name: String(e.name), description: String(e.description) }))
      : []
    return {
      found: true,
      id: found.id,
      published: true,
      publishes: catalogs.length,
      isUpdate: last.source.update === true,
      chars: text.length,
      tokens: estimateTokens(text),
      historyChars,
      historyTokens,
      entries,
      preview: text,
      error: null,
    }
  }

  // ---------- 组装模型目录 ----------
  function buildModel(groups, registry, session, cap) {
    const registryByName = new Map()
    for (const item of registry.skills) if (item && item.name) registryByName.set(item.name, item)
    const publishedByName = new Map()
    for (const item of session.entries || []) if (item && item.name) publishedByName.set(item.name, item)

    const rows = []
    const seen = new Set()

    const push = (name, group, reg, pub) => {
      const winner = group ? group[0] : null
      const duplicates = group ? group.slice(1) : []
      const rawDescription = reg ? String(reg.description || '') : winner ? winner.description : pub ? String(pub.description) : ''
      const normalized = normalizeDescription(rawDescription)
      const truncated = normalized.length > cap
      const effective = truncated ? applyCap(normalized, cap) : normalized
      const modelInvocable = reg
        ? Boolean(reg.invocation && reg.invocation.modelInvocable)
        : winner ? winner.modelInvocable : true
      const userInvocable = reg
        ? Boolean(reg.invocation && reg.invocation.userInvocable)
        : winner ? winner.userInvocable : true
      const source = reg
        ? SOURCE_OF_REGISTRY[reg.source] || 'other'
        : winner ? winner.occ.kind : 'session'
      const entryFile = reg && reg.path ? String(reg.path) : winner ? winner.occ.entryFile : null
      const occ = winner ? winner.occ : null
      const reasons = []
      if (truncated) reasons.push('truncated')
      if (!modelInvocable) reasons.push('hidden')
      if (!normalized) reasons.push('no-description')
      if (occ && occ.bytes > BIG_BODY_BYTES) reasons.push('big-body')
      if (duplicates.length > 0) reasons.push('duplicate')
      const sessionOnly = !group && !reg && Boolean(pub)
      if (sessionOnly) reasons.push('session-only')
      if (!userInvocable) reasons.push('model-only')

      const line = catalogLine(name, effective)
      rows.push({
        name,
        description: normalized,
        effective,
        truncated,
        chars: modelInvocable ? line.length : 0,
        tokens: modelInvocable ? estimateTokens(line) : 0,
        visible: modelInvocable,
        userInvocable,
        inCatalog: Boolean(reg) || Boolean(winner) || Boolean(pub),
        sessionOnly,
        stale: false,
        source,
        provider: reg ? String(reg.provider || '') : 'filesystem',
        dir: occ ? occ.dir : (entryFile ? entryFile.slice(0, entryFile.lastIndexOf('/')) : null),
        realDir: occ ? occ.realDir : null,
        entryFile,
        linkTarget: occ && occ.link ? occ.link : null,
        files: occ ? occ.files.slice() : [],
        bodyBytes: occ ? occ.bytes : 0,
        bodyTokens: occ ? Math.ceil(occ.bytes / 4) : 0,
        writable: Boolean(occ) && WRITABLE.has(occ.kind),
        deletable: Boolean(occ) && WRITABLE.has(occ.kind),
        duplicates: duplicates.map((d) => ({ root: d.occ.root, dir: d.occ.dir, entryFile: d.occ.entryFile, source: d.occ.kind, link: d.occ.link || null })),
        reasons,
      })
      seen.add(name)
    }

    for (const [name, group] of groups) push(name, group, registryByName.get(name), publishedByName.get(name))
    for (const [name, reg] of registryByName) if (!seen.has(name)) push(name, null, reg, null)
    for (const [name, pub] of publishedByName) if (!seen.has(name)) push(name, null, null, pub)

    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return rows
  }

  // 与 dsh-tool-skill 的两种渲染逐字对齐：首次发布用 ENVELOPE_LINES，之后用变更版。
  function composeCatalogText(lines, update) {
    if (!update) return ENVELOPE_LINES.slice(0, 4).concat(lines, ENVELOPE_LINES.slice(4)).join('\n')
    const availability = lines.length === 0 ? EMPTY_AVAILABILITY : UPDATE_AVAILABILITY
    return ['<system-reminder>', UPDATE_HEADER, '', '<available_skills>']
      .concat(lines, ['</available_skills>', ''], availability, ['</system-reminder>'])
      .join('\n')
  }

  function catalogLines(rows, cap) {
    return rows
      .filter((row) => row.visible)
      .map((row) => catalogLine(row.name, escapeText(applyCap(normalizeDescription(row.description), cap))))
  }

  function driftOf(sessionEntries, rows) {
    const published = new Map((sessionEntries || []).map((e) => [e.name, e.description]))
    const current = new Map(rows.filter((r) => r.visible).map((r) => [r.name, r.effective]))
    const added = []
    const removed = []
    const changed = []
    for (const [name, description] of current) {
      if (!published.has(name)) added.push(name)
      else if (published.get(name) !== description) changed.push(name)
    }
    for (const name of published.keys()) if (!current.has(name)) removed.push(name)
    return { added, removed, changed, stale: added.length + removed.length + changed.length > 0 }
  }

  async function resolveCwd(args) {
    if (args && typeof args.cwd === 'string' && args.cwd) return args.cwd
    if (args && typeof args.projectPath === 'string' && args.projectPath) return args.projectPath
    const agents = service('agents')
    if (agents !== undefined && typeof agents.currentInitiator === 'function') {
      try {
        const init = agents.currentInitiator()
        const cwd = init && init.session && init.session.header && init.session.header.cwd
        if (typeof cwd === 'string' && cwd) return cwd
      } catch (e) { /* ignore */ }
    }
    return null
  }

  // 与官方 findProjectRoot 对齐：沿 cwd 向上找 .git，找不到就用 cwd。
  async function findProjectRoot(cwd) {
    if (!cwd) return null
    const fs = service('fs')
    let current = cwd
    for (let i = 0; i < 64; i++) {
      if (fs !== undefined) {
        try {
          const target = await fs.resolve(joinPath(current, '.git'))
          if (await fs.stat(target) !== undefined) return current
        } catch (e) { /* 继续向上 */ }
      }
      const parent = current.slice(0, current.lastIndexOf('/'))
      if (!parent || parent === current) return cwd
      current = parent
    }
    return cwd
  }

  // ---------- 上下文分析 ----------
  async function analyze(args) {
    const env = await readEnv()
    const cwd = await resolveCwd(args)
    const projectRoot = await findProjectRoot(cwd)
    const roots = rootList(env, projectRoot)
    const scan = await scanRoots(roots, env)
    if (scan.error) {
      return { env, cwd: projectRoot || cwd, projectRoot, roots, scanError: scan.error, groups: new Map(), invalid: [], occurrences: [], rootsSeen: [] }
    }
    const inspected = await inspectOccurrences(scan.occurrences)
    const groups = groupWinners(inspected.valid)
    return { env, cwd: projectRoot || cwd, projectRoot, roots, rootsSeen: scan.rootsSeen, occurrences: scan.occurrences, groups, invalid: inspected.invalid, scanError: null }
  }

  // ---------- 目录描述上限 ----------
  let capCache = null
  async function detectCatalogCap(profileDir) {
    if (capCache !== null) return capCache
    let cap = CAP_DEFAULT
    if (profileDir) {
      const r = await runShell(
        `grep -ho 'catalogDescriptionMaxLength:[[:space:]]*[0-9]\\{1,6\\}' ${esc(joinPath(profileDir, 'cordis.patch.yml'))} ${esc(joinPath(profileDir, 'dsh.yml'))} ${esc(joinPath(profileDir, 'cordis.yml'))} 2>/dev/null | tail -n 1`,
        { timeoutMs: 10000 },
      )
      const m = /catalogDescriptionMaxLength:\s*(\d+)/.exec(r.stdout || '')
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n >= 3) cap = n
      }
    }
    capCache = cap
    return cap
  }

  // ---------- RPC: overview ----------
  async function rpcOverview(args) {
    try {
      const data = await analyze(args)
      const cap = await detectCatalogCap(data.env.profileDir)
      const registry = await readRegistryCatalog(data.cwd)
      const session = readSessionCatalog(args)
      const rows = buildModel(data.groups, registry, session, cap)

      const visible = rows.filter((r) => r.visible)
      const republish = (session.publishes || 0) > 0
      const lines = catalogLines(rows, cap)
      const preview = composeCatalogText(lines, republish)
      const entriesChars = lines.join('\n').length
      const entriesTokens = estimateTokens(lines.join('\n'))
      const catalogChars = preview.length
      const catalogTokens = estimateTokens(preview)
      const drift = session.published ? driftOf(session.entries, rows.filter((r) => !r.sessionOnly)) : null
      if (drift !== null) {
        for (const row of rows) {
          if (row.sessionOnly) row.stale = drift.removed.indexOf(row.name) !== -1
        }
      }

      const diagnostics = data.invalid.slice()
      for (const group of data.groups.values()) {
        for (const dup of group.slice(1)) {
          diagnostics.push({
            name: group[0].name,
            reason: 'shadowed',
            detail: `同名 skill 的另一份在 ${dup.occ.root}（rank ${RANK_OF[dup.occ.kind] || 900}），DSH 只采用排名更高的那份`,
            path: dup.occ.entryFile,
            source: dup.occ.kind,
          })
        }
      }

      return {
        ok: true,
        cap,
        tokenNote: 'token 为估算值（CJK ≈ 1.1/字，其余 ≈ 4 字符/token）',
        scope: {
          cwd: data.cwd,
          projectRoot: data.projectRoot,
          projectSkillsDir: data.projectRoot ? joinPath(data.projectRoot, '.dsh/skills') : null,
          userSkillsDir: joinPath(data.env.dshHome, 'skills'),
          agentsSkillsDir: joinPath(data.env.agentsHome, 'skills'),
        },
        env: { dshHome: data.env.dshHome, agentsHome: data.env.agentsHome, profile: data.env.profile, profileDir: data.env.profileDir },
        catalog: {
          source: registry.skills.length > 0 ? 'registry' : 'filesystem',
          registryAvailable: registry.available,
          registryError: registry.error || null,
          total: rows.length,
          visible: visible.length,
          chars: catalogChars,
          tokens: catalogTokens,
          entriesChars,
          entriesTokens,
          envelopeChars: catalogChars - entriesChars,
          envelopeTokens: catalogTokens - entriesTokens,
          currentTokens: session.published ? session.tokens : null,
          republish,
          preview,
        },
        session: {
          id: session.id,
          found: session.found,
          published: session.published,
          publishes: session.publishes,
          isUpdate: Boolean(session.isUpdate),
          chars: session.chars,
          tokens: session.tokens,
          historyChars: session.historyChars,
          historyTokens: session.historyTokens,
          entries: session.entries,
          preview: session.preview,
          drift,
          error: session.error || null,
        },
        rows,
        diagnostics,
        roots: data.rootsSeen || [],
        scanError: data.scanError || null,
        debug: args && args.debug ? { roots: data.roots, occurrences: data.occurrences.length, invalid: data.invalid.length } : undefined,
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 400) }
    }
  }

  // ---------- RPC: set-model-invocation ----------
  async function rpcSetModelInvocation(args) {
    const name = args && typeof args.name === 'string' ? args.name : ''
    const enabled = Boolean(args && args.enabled)
    if (!name) return { ok: false, error: '缺少 skill 名称' }
    try {
      const data = await analyze(args)
      const group = data.groups.get(name)
      if (!group) return { ok: false, error: '未找到该 skill 的可写文件（可能只存在于会话目录中）' }
      const writable = group.filter((item) => WRITABLE.has(item.occ.kind))
      if (writable.length === 0) {
        return { ok: false, error: `该 skill 位于受保护目录（${group[0].occ.root}），请在来源插件/预设中修改` }
      }
      const target = writable[0].occ
      const text = await readSkillFile(target.entryFile)
      if (text === null) return { ok: false, error: '无法读取该 skill 的指令文件' }
      const next = withModelInvocation(text, enabled)
      if (next.error) return { ok: false, error: next.error }
      if (next.text === text) return { ok: true, name, enabled, path: target.entryFile, unchanged: true }
      const written = await writeTextAt(target.entryFile, next.text)
      if (!written.ok) return { ok: false, error: written.error }
      return {
        ok: true,
        name,
        enabled,
        path: target.entryFile,
        shadowed: group.length > 1,
        note: '目录会在下一次模型请求前刷新；本会话已发布的旧目录仍留在历史中',
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) }
    }
  }

  // ---------- RPC: read-file ----------
  async function rpcReadFile(args) {
    const p = args && args.path
    if (typeof p !== 'string' || !p) return { ok: false, error: '缺少路径' }
    try {
      const data = await analyze(args)
      const allowed = (data.rootsSeen || []).some((root) => p === root || p.indexOf(root + '/') === 0)
      if (!allowed) return { ok: false, error: '路径不在技能目录内' }
      const text = await readSkillFile(p)
      if (text === null) return { ok: false, error: '无法读取文件' }
      const max = 200 * 1024
      return { ok: true, path: p, content: text.length > max ? text.slice(0, max) : text, truncated: text.length > max, bytes: text.length, tokens: estimateTokens(text) }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
    }
  }

  // ---------- RPC: resolve-target ----------
  async function rpcResolveTarget(args) {
    const env = await readEnv()
    const cwd = await resolveCwd(args)
    const projectRoot = await findProjectRoot(cwd)
    return {
      ok: true,
      user: joinPath(env.dshHome, 'skills'),
      project: projectRoot ? joinPath(projectRoot, '.dsh/skills') : null,
      projects: projectRoot ? [joinPath(projectRoot, '.dsh/skills')] : [],
      cwd: projectRoot || cwd,
    }
  }

  // ---------- RPC: delete-skill ----------
  async function rpcDeleteSkill(args) {
    const name = args && args.name
    if (typeof name !== 'string' || !name) return { ok: false, error: '缺少 skill 名称' }
    try {
      const data = await analyze(args)
      const group = data.groups.get(name)
      if (!group) {
        const bad = data.invalid.find((x) => x.name === name)
        return { ok: false, error: bad ? `该 skill 未通过校验（${bad.detail}）；如需清理请手动删除 ${bad.path}` : '未找到该 skill 的文件路径' }
      }
      const writable = group.filter((item) => WRITABLE.has(item.occ.kind))
      if (writable.length === 0) {
        return { ok: false, error: `该 skill 位于受保护目录（${group[0].occ.root}），不能从这里卸载；请直接管理其来源插件或预设` }
      }
      const target = writable[0].occ
      const location = target.dir || target.entryFile
      if (!location) return { ok: false, error: '无法确定删除路径' }
      const policy = !isInsideWorkspace(location) && service('sandboxPolicy') !== undefined
        ? service('sandboxPolicy').resolve({ mode: 'danger-full-access' })
        : undefined
      const rm = await runShell(`rm -rf -- ${esc(location)}`, { policy, timeoutMs: 20000 })
      if (rm.exitCode !== 0) return { ok: false, error: `删除失败: ${String(rm.stderr).slice(0, 200)}` }
      return { ok: true, name, removed: location, wasSymlink: Boolean(target.link), shadowed: writable.length > 1 }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) }
    }
  }

  // ---------- 网络与导入 ----------
  async function fetchText(url) {
    const web = service('web')
    if (web !== undefined) {
      try {
        const res = await web.fetch({ url })
        if (res && res.statusCode >= 200 && res.statusCode < 300 && res.body && typeof res.body.content === 'string') {
          return { ok: true, content: res.body.content, status: res.statusCode }
        }
        if (res) return { ok: false, error: `HTTP ${res.statusCode}`, status: res.statusCode }
      } catch (err) { /* fall through to curl */ }
    }
    const r = await runShell(`curl -fsSL --max-time 90 ${esc(url)}`, { timeoutMs: 100000, stdoutMaxBytes: 5 * 1024 * 1024 })
    if (r.exitCode === 0) return { ok: true, content: r.stdout, status: 200 }
    return { ok: false, error: String(r.stderr || 'curl 下载失败').slice(0, 300), status: 0 }
  }

  async function fetchJson(url) {
    const r = await fetchText(url)
    if (!r.ok) return { ok: false, error: r.error }
    try {
      return { ok: true, data: JSON.parse(r.content) }
    } catch (e) {
      return { ok: false, error: `响应不是 JSON: ${String(r.content).slice(0, 120)}` }
    }
  }

  function parseImportUrl(raw) {
    let u = String(raw || '').trim()
    if (!u) return { error: 'URL 为空' }
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u
    let m
    try { m = /^https?:\/\/([^/?#]+)\/?(.*)$/i.exec(u) } catch (e) { return { error: 'URL 无效' } }
    const host = (m[1] || '').toLowerCase().replace(/^www\./, '')
    const path = (m[2] || '').split(/[?#]/)[0].replace(/\/+$/, '')
    if (host === 'clawhub.ai') {
      const segs = path.split('/').filter(Boolean)
      if (segs.length < 2) return { error: 'ClawHub 链接格式: clawhub.ai/<owner>/<skill>' }
      const owner = segs[0]
      const slug = segs[1] === 'skills' ? segs[2] : segs[1]
      if (!slug) return { error: 'ClawHub 链接缺少 skill 名' }
      return { source: 'clawhub', owner, slug }
    }
    if (host === 'skills.sh') {
      const segs = path.split('/').filter(Boolean)
      if (segs.length < 2) return { error: 'Skills.sh 链接格式: skills.sh/<owner>/<repo>/<skill>' }
      return { source: 'skills-sh', owner: segs[0], repo: segs[1], skill: segs.slice(2).join('/') || null }
    }
    if (host === 'github.com' || host === 'raw.githubusercontent.com') {
      const segs = path.split('/').filter(Boolean)
      if (segs.length < 2) return { error: 'GitHub 链接格式: github.com/<owner>/<repo>[/tree/<branch>/<path>]' }
      let rest = segs.slice(2)
      let ref = null
      let sub = null
      if (host === 'raw.githubusercontent.com') {
        ref = rest.shift() || null
        sub = rest.join('/') || null
      } else if (rest[0] === 'tree' || rest[0] === 'blob') {
        rest.shift()
        ref = rest.shift() || null
        sub = rest.join('/') || null
      } else {
        sub = rest.join('/') || null
      }
      return { source: 'github', owner: segs[0], repo: segs[1].replace(/\.git$/, ''), ref, path: sub }
    }
    return { error: `不支持的来源: ${host}（支持 ClawHub、Skills.sh、GitHub）` }
  }

  async function resolveInstallRoot(target, args) {
    if (target === 'project') {
      const cwd = await resolveCwd(args)
      const projectRoot = await findProjectRoot(cwd)
      if (!projectRoot) return { ok: false, error: '无法确定项目根目录' }
      const root = joinPath(projectRoot, '.dsh/skills')
      return { ok: true, root, escalated: !isInsideWorkspace(root) }
    }
    const env = await readEnv()
    return { ok: true, root: joinPath(env.dshHome, 'skills'), escalated: true }
  }

  async function writeSkillFile(rootDir, name, rel, content) {
    if (!rel || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return { ok: false, error: `非法路径: ${rel}` }
    const abs = joinPath(joinPath(rootDir, name), rel)
    try {
      const dir = abs.slice(0, abs.lastIndexOf('/'))
      const mk = await runShell(`mkdir -p ${esc(dir)}`, { policy: writePolicy, timeoutMs: 15000 })
      if (mk.exitCode !== 0) return { ok: false, error: `创建目录失败: ${String(mk.stderr).slice(0, 200)}` }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
    }
    return writeTextAt(abs, content)
  }

  async function installUnits(rootDir, units, fetchFile) {
    const results = []
    let tooBig = false
    let totalBytes = 0
    for (const unit of units) {
      const written = []
      const warnings = []
      let guard = false
      for (const f of unit.files) {
        if (guard) break
        if (tooBig) break
        const r = await fetchFile(f.p)
        if (!r.ok) { warnings.push(`${f.p}: ${r.error}`); continue }
        totalBytes += r.content.length
        if (totalBytes > 8 * 1024 * 1024) { tooBig = true; warnings.push('总大小超过 8MB，剩余文件已跳过'); continue }
        if (written.length >= 300) { guard = true; warnings.push('单 skill 文件数超过 300，已截断'); break }
        const w = await writeSkillFile(rootDir, unit.name, f.rel, r.content)
        if (w.ok) written.push(f.rel)
        else warnings.push(`${f.p}: ${w.error}`)
      }
      results.push({
        name: unit.name,
        version: unit.version || null,
        dir: joinPath(rootDir, unit.name),
        files: written,
        warnings,
        security: unit.security || null,
        changelog: unit.changelog || null,
      })
    }
    return {
      ok: results.some((x) => x.files.length > 0),
      error: results.some((x) => x.files.length > 0) ? null : (results[0] && results[0].warnings && results[0].warnings[0]) || '没有写入任何文件',
      results,
    }
  }

  async function importClawhub(info, rootDir) {
    const base = `https://clawhub.ai/api/v1/skills/${enc(info.slug)}`
    const q = `ownerHandle=${enc(info.owner)}`
    const vlist = await fetchJson(`${base}/versions?${q}`)
    if (!vlist.ok) return { ok: false, error: `无法获取版本列表: ${vlist.error}` }
    const items = vlist.data && vlist.data.items
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: '该 skill 没有可用的版本' }
    const version = items[0].version
    const vd = await fetchJson(`${base}/versions/${enc(version)}?${q}`)
    if (!vd.ok) return { ok: false, error: `无法获取文件列表: ${vd.error}` }
    const ver = vd.data && vd.data.version
    const files = ver && ver.files
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: '该版本没有文件' }
    const units = [{
      name: info.slug,
      version,
      security: ver && ver.security && ver.security.status ? String(ver.security.status) : null,
      changelog: ver && ver.changelog ? String(ver.changelog) : null,
      files: files.map((f) => ({ p: String(f.path || ''), rel: String(f.path || '') })),
    }]
    return installUnits(rootDir, units, async (p) => {
      if (!p || p.split('/').some((s) => s === '..' || s === '')) return { ok: false, error: `非法路径: ${p}` }
      return fetchText(`${base}/file?path=${enc(p)}&${q}`)
    })
  }

  async function githubResolveTree(owner, repo, ref) {
    let branch = null
    if (ref && ref !== 'HEAD') branch = ref
    else {
      const r = await fetchJson(`https://api.github.com/repos/${enc(owner)}/${enc(repo)}`)
      if (r.ok && r.data && typeof r.data.default_branch === 'string') branch = r.data.default_branch
      else {
        for (const b of ['main', 'master']) {
          const t = await fetchText(`https://raw.githubusercontent.com/${enc(owner)}/${enc(repo)}/${b}/README.md`)
          if (t.ok) { branch = b; break }
        }
      }
    }
    if (!branch) return { ok: false, error: `无法确定仓库 ${owner}/${repo} 的默认分支` }
    const t = await fetchJson(`https://api.github.com/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(branch)}?recursive=1`)
    if (!t.ok) return { ok: false, error: `获取仓库树失败: ${t.error}` }
    const tree = t.data && t.data.tree
    if (!Array.isArray(tree)) return { ok: false, error: '仓库树为空' }
    if (t.data.truncated) return { ok: false, error: '仓库太大，目录树被截断；请在 URL 中指定 skill 子目录' }
    const blobs = tree.filter((e) => e && e.type === 'blob' && typeof e.path === 'string').map((e) => e.path)
    return { ok: true, branch, blobs }
  }

  async function importGithub(info, rootDir, treeResult) {
    let t = treeResult
    if (!t) {
      t = await githubResolveTree(info.owner, info.repo, info.ref)
      if (!t.ok) return { ok: false, error: t.error }
    }
    const blobs = t.blobs
    let units = []
    if (info.path) {
      const prefix = info.path.replace(/^\/+|\/+$/g, '')
      const files = blobs.filter((p) => p === prefix || p.startsWith(prefix + '/'))
      if (files.length === 0) return { ok: false, error: `路径 "${info.path}" 下没有文件` }
      units = [{ name: prefix.split('/').pop() || info.repo, files: files.map((p) => ({ p, rel: p === prefix ? p.split('/').pop() : p.slice(prefix.length + 1) })) }]
    } else {
      const skillDirs = new Set()
      for (const p of blobs) {
        const head = p.slice(0, -9)
        if (p.endsWith('/SKILL.md') && head.indexOf('/') === -1) skillDirs.add(head)
      }
      if (skillDirs.size > 0) {
        units = Array.from(skillDirs).sort().map((d) => ({
          name: d,
          files: blobs.filter((p) => p === d || p.startsWith(d + '/')).map((p) => ({ p, rel: p === d ? p.split('/').pop() : p.slice(d.length + 1) })),
        }))
      } else if (blobs.indexOf('SKILL.md') !== -1) {
        units = [{ name: info.repo, files: blobs.map((p) => ({ p, rel: p })) }]
      } else {
        return { ok: false, error: `仓库中没有 SKILL.md；请在 URL 中指定 skill 子目录: github.com/${info.owner}/${info.repo}/tree/${t.branch}/<路径>` }
      }
    }
    return installUnits(rootDir, units, (p) => fetchText(`https://raw.githubusercontent.com/${enc(info.owner)}/${enc(info.repo)}/${enc(t.branch)}/${p.split('/').map(enc).join('/')}`))
  }

  async function importSkillsSh(info, rootDir) {
    const t = await githubResolveTree(info.owner, info.repo, info.ref || null)
    if (!t.ok) return { ok: false, error: t.error }
    if (info.skill) {
      const skill = info.skill.toLowerCase()
      const candidates = [info.skill, `skills/${info.skill}`]
      for (const c of candidates) {
        const has = t.blobs.indexOf(c + '/SKILL.md') !== -1 || t.blobs.some((p) => p.startsWith(c + '/') && /\.md$/i.test(p))
        if (has) return importGithub({ source: 'github', owner: info.owner, repo: info.repo, ref: t.branch, path: c }, rootDir, t)
      }
      const skillDirs = t.blobs.filter((p) => /\/SKILL\.md$/i.test(p)).map((p) => p.slice(0, -9))
      const matches = skillDirs.filter((d) => d.toLowerCase().endsWith('/' + skill) || d.toLowerCase() === skill)
      if (matches.length > 0) {
        matches.sort((a, b) => Number(b.startsWith('skills/')) - Number(a.startsWith('skills/')))
        return importGithub({ source: 'github', owner: info.owner, repo: info.repo, ref: t.branch, path: matches[0] }, rootDir, t)
      }
      const names = Array.from(new Set(skillDirs.map((d) => d.split('/').pop()))).sort().slice(0, 20)
      const hint = names.length > 0 ? `。仓库内可用的 skill: ${names.join('、')}${skillDirs.length > 20 ? ' …' : ''}` : ''
      return { ok: false, error: `在 GitHub 仓库 ${info.owner}/${info.repo} 中未找到 skill "${info.skill}"（已查找 ${candidates.join('、')} 及任意子目录）${hint}。也可改用 GitHub 直链指定路径导入。` }
    }
    return importGithub({ source: 'github', owner: info.owner, repo: info.repo, ref: t.branch, path: null }, rootDir, t)
  }

  async function rpcImportSkill(args) {
    const url = args && args.url
    const target = args && args.target === 'project' ? 'project' : 'user'
    const parsed = parseImportUrl(url)
    if (parsed.error) return { ok: false, error: parsed.error }
    const rootRes = await resolveInstallRoot(target, args)
    if (!rootRes.ok) return { ok: false, error: rootRes.error }
    writePolicy = rootRes.escalated && service('sandboxPolicy') !== undefined
      ? service('sandboxPolicy').resolve({ mode: 'danger-full-access' })
      : undefined
    let result
    try {
      if (parsed.source === 'clawhub') result = await importClawhub(parsed, rootRes.root)
      else if (parsed.source === 'skills-sh') result = await importSkillsSh(parsed, rootRes.root)
      else if (parsed.source === 'github') result = await importGithub(parsed, rootRes.root, null)
      else result = { ok: false, error: '未知来源' }
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) }
    }
    result.installRoot = rootRes.root
    result.target = target
    return result
  }

  // ---------- 路由 ----------
  const routes = [
    ['overview', rpcOverview],
    ['scan-skills', rpcOverview],
    ['read-file', rpcReadFile],
    ['resolve-target', rpcResolveTarget],
    ['delete-skill', rpcDeleteSkill],
    ['import-skill', rpcImportSkill],
    ['set-model-invocation', rpcSetModelInvocation],
  ]
  const webServer = service('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    for (const [method, logic] of routes) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `/api/skills-hub/${method}`,
        handler: jsonRoute(logic),
      }))
    }
  } else {
    console.error('[dsh-skills-hub] webServer 服务不可用，API 路由未注册')
  }
}
