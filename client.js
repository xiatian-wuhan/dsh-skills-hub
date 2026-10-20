// dsh-skills-hub 客户端 bundle（静态插件约定：window.__ModuleLoader__.load 工厂）。
//
// 这一版围绕「技能对模型上下文的作用」组织界面：
//   - 顶部上下文总览：模型可见数、每次请求的目录成本、本会话已发布几次；
//   - 每张卡片：目录行成本（≈token）、是否被截断、是否已隐藏、正文体积；
//   - 「模型看到的目录」：预演（下次发布）与实际（本会话已发布）对照；
//   - 一键切换 disable-model-invocation，把 skill 从模型目录摘掉（文件保留）。
//
// 通信：fetch('/api/skills-hub/<method>') → Host 的 webServer 路由。

window.__ModuleLoader__.load({
  id: "dsh-skills-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var Fragment = react.Fragment;

    const css = `
.sh-wrap{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;min-width:0}
.sh-panel{border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:12px;padding:12px 14px;background:color-mix(in srgb,currentColor 3%,transparent)}
.sh-card{border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:10px;padding:10px 12px;background:color-mix(in srgb,currentColor 2%,transparent)}
.sh-card.sh-dim{opacity:.72}
.sh-name{font-weight:600}
.sh-desc{margin-top:3px;color:color-mix(in srgb,currentColor 70%,transparent)}
.sh-meta{margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:color-mix(in srgb,currentColor 55%,transparent);word-break:break-all}
.sh-files{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.sh-chip{border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:1px 7px;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sh-btn{cursor:pointer;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;padding:5px 12px;background:transparent;color:inherit;font-size:12px}
.sh-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 7%,transparent)}
.sh-btn:disabled{opacity:.5;cursor:default}
.sh-btn-sm{padding:3px 9px;font-size:11px}
.sh-btn-primary{background:color-mix(in srgb,currentColor 14%,transparent)}
.sh-btn-danger{color:#e5484d;border-color:color-mix(in srgb,#e5484d 55%,transparent)}
.sh-tabs{display:flex;gap:8px}
.sh-tab{padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font-size:13px}
.sh-tab.on{background:color-mix(in srgb,currentColor 15%,transparent)}
.sh-tab-sm{padding:3px 10px;font-size:12px;border-radius:7px}
.sh-tab-sm .sh-count{opacity:.6;margin-left:4px}
.sh-input{width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:7px 10px;background:transparent;color:inherit;font-size:13px}
.sh-pre{white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:8px;padding:10px;margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:color-mix(in srgb,currentColor 3%,transparent)}
.sh-error{color:#e5484d}
.sh-ok{color:#30a46c}
.sh-warn{color:#d98a00}
.sh-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sh-grow{flex:1;min-width:0}
.sh-hint{font-size:12px;color:color-mix(in srgb,currentColor 62%,transparent)}
.sh-section{margin-top:10px}
.sh-sec-title{font-weight:600;margin-bottom:6px}
.sh-src{border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:6px;padding:0 6px;font-size:10px;color:color-mix(in srgb,currentColor 60%,transparent);white-space:nowrap}
.sh-cost{border-radius:6px;padding:0 6px;font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:color-mix(in srgb,currentColor 70%,transparent);white-space:nowrap}
.sh-cost.hot{color:#d98a00;border-color:color-mix(in srgb,#d98a00 45%,transparent)}
.sh-flag{border-radius:6px;padding:0 6px;font-size:10px;white-space:nowrap;border:1px solid color-mix(in srgb,currentColor 22%,transparent);color:color-mix(in srgb,currentColor 62%,transparent)}
.sh-flag.warn{color:#d98a00;border-color:color-mix(in srgb,#d98a00 45%,transparent)}
.sh-flag.hide{color:#e5484d;border-color:color-mix(in srgb,#e5484d 40%,transparent)}
.sh-kpi{display:flex;gap:18px;flex-wrap:wrap;margin-top:8px}
.sh-kpi-item{display:flex;flex-direction:column;gap:1px;min-width:96px}
.sh-kpi-v{font-size:16px;font-weight:600;line-height:1.25}
.sh-kpi-k{font-size:11px;color:color-mix(in srgb,currentColor 55%,transparent)}
.sh-list{display:flex;flex-direction:column;gap:8px}
.sh-diag{display:flex;gap:8px;align-items:baseline;font-size:12px;padding:3px 0}
.sh-diag-r{flex:0 0 auto;font-size:10px;border-radius:5px;padding:0 5px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);color:color-mix(in srgb,currentColor 62%,transparent)}
`;

    const SOURCE_LABELS = {
      user: '全局用户目录',
      agents: '~/.agents',
      project: '当前项目',
      custom: '自定义目录',
      plugin: '插件内置',
      preset: '预设内置',
      bundled: '内置',
      runtime: '运行时',
      session: '会话级',
      other: '其他',
    };

    // 内置 = 随 DSH / 插件 / 预装一起分发的；第三方 = 装在项目或用户目录、可自由修改的。
    const BUILTIN_SOURCES = { preset: 1, plugin: 1, bundled: 1, runtime: 1 };
    const BUCKETS = [
      { id: 'all', label: '全部', hint: '全部已安装 skill' },
      { id: 'builtin', label: '内置', hint: '随 DSH、插件或预设一起安装，只读' },
      { id: 'third-party', label: '第三方', hint: '装在项目或用户目录，可隐藏/删除' },
    ];

    function bucketOf(row) {
      if (row && (row.bucket === 'builtin' || row.bucket === 'third-party')) return row.bucket;
      return row && BUILTIN_SOURCES[row.source] ? 'builtin' : 'third-party';
    }

    const REASON_LABELS = {
      truncated: '描述被截断',
      hidden: '已从模型目录隐藏',
      'no-description': '缺少介绍',
      'big-body': '正文偏大',
      duplicate: '同名冲突',
      'session-only': '会话级可见',
      'model-only': '仅模型可用',
    };

    const DIAG_LABELS = {
      hidden: '已隐藏',
      invalid: '格式无效',
      shadowed: '同名冲突',
      'not-registered': '未注册',
      unreadable: '不可读',
      'not-indexed': '待索引',
    };

    const TOKEN_HOT = 200;

    function injectCss(tagId, cssText) {
      if (typeof document === 'undefined') return undefined;
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return undefined;
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', tagId);
      tag.textContent = cssText;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }

    async function rpc(method, args) {
      const res = await fetch('/api/skills-hub/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      return data;
    }

    function detectSource(url) {
      let u = String(url || '').trim();
      if (!u) return null;
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      const m = /^https?:\/\/([^/?#]+)/i.exec(u);
      if (!m) return null;
      const host = m[1].toLowerCase().replace(/^www\./, '');
      if (host === 'clawhub.ai') return 'ClawHub';
      if (host === 'skills.sh') return 'Skills.sh';
      if (host === 'github.com' || host === 'raw.githubusercontent.com') return 'GitHub';
      return '未知来源';
    }

    function fmtTok(n) {
      const v = Number(n) || 0;
      if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
      if (v >= 1000) return (v / 1000).toFixed(2) + 'k';
      return String(v);
    }

    function fmtBytes(n) {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
      return v + ' B';
    }

    function CostBadge(props) {
      const tokens = Number(props.tokens) || 0;
      if (!props.visible) return h('span', { className: 'sh-flag hide', title: '已从模型技能目录隐藏，不占用上下文' }, '0 tok');
      return h('span', { className: 'sh-cost' + (tokens > TOKEN_HOT ? ' hot' : ''), title: '该 skill 在技能目录中的一行所占 token（估算）' }, '≈' + fmtTok(tokens) + ' tok');
    }

    function Flag(props) {
      return h('span', { className: 'sh-flag' + (props.warn ? ' warn' : '') + (props.hide ? ' hide' : ''), title: props.title || null }, props.children);
    }

    function Kpi(props) {
      return h('div', { className: 'sh-kpi-item' },
        h('div', { className: 'sh-kpi-v' }, props.value),
        h('div', { className: 'sh-kpi-k' }, props.label),
      );
    }

    function Summary(props) {
      const data = props.data;
      const catalog = data.catalog || {};
      const session = data.session || {};
      const rows = data.rows || [];
      const hiddenCount = rows.filter((r) => !r.visible).length;
      const truncatedCount = rows.filter((r) => r.truncated).length;
      const duplicateCount = rows.filter((r) => (r.duplicates || []).length > 0).length;
      const drift = session.drift;
      const staleCount = drift ? drift.added.length + drift.removed.length + drift.changed.length : 0;

      return h('div', { className: 'sh-panel' },
        h('div', { className: 'sh-row' },
          h('div', { className: 'sh-name', style: { fontSize: 14 } }, '技能目录上下文'),
          h('div', { className: 'sh-grow' }),
          h('button', { className: 'sh-btn sh-btn-sm', onClick: props.onPreview }, '模型看到的目录'),
          h('button', { className: 'sh-btn sh-btn-sm', onClick: props.onToggleSort }, props.sortBy === 'cost' ? '按名称排序' : '按成本排序'),
        ),
        h('div', { className: 'sh-kpi' },
          h(Kpi, { value: String(catalog.visible || 0) + ' / ' + String(catalog.total || 0), label: '模型可见 / 全部' }),
          h(Kpi, { value: '≈' + fmtTok(catalog.currentTokens != null ? catalog.currentTokens : catalog.tokens), label: '目录成本 / 次请求' }),
          h(Kpi, { value: String(session.publishes || 0) + ' 次', label: '本会话已发布' }),
          h(Kpi, { value: '≈' + fmtTok(session.historyTokens), label: '目录历史占用' }),
          h(Kpi, { value: String(data.cap || '—') + ' 字符', label: '描述上限' }),
        ),
        h('div', { className: 'sh-hint', style: { marginTop: 8 } },
          '目录会在每次请求前作为一条 user 消息进入上下文；每条 = 名称 + 截断后的介绍（每行约 6 + 名称 + 介绍字符），另有约 '
          + fmtTok(catalog.envelopeTokens) + ' tok 的固定说明。正文只在模型调用 skill 时加载，且永久留在历史里。'
          + (catalog.source === 'filesystem' ? '数据来自技能目录扫描（本部署的技能插件按预设挂载，注册表全局层为空）。' : '数据来自 skills 注册表。'),
        ),
        h('div', { className: 'sh-row', style: { marginTop: 8, gap: 6 } },
          staleCount > 0
            ? h('span', { className: 'sh-warn' }, '目录已变更：+ ' + drift.added.length + ' / - ' + drift.removed.length + ' / ~ ' + drift.changed.length + '，下次请求将追加一份完整副本')
            : session.published
              ? h('span', { className: 'sh-ok' }, '本会话已发布的目录与当前一致')
              : h('span', { className: 'sh-hint' }, '本会话尚未发布技能目录（首次请求前会发布）'),
        ),
        (truncatedCount + hiddenCount + duplicateCount) > 0
          ? h('div', { className: 'sh-row', style: { marginTop: 6, gap: 6 } },
              truncatedCount > 0 ? h(Flag, { warn: true, title: '介绍超过描述上限，模型只看到截断后的版本' }, truncatedCount + ' 个描述被截断') : null,
              hiddenCount > 0 ? h(Flag, { hide: true }, hiddenCount + ' 个已隐藏') : null,
              duplicateCount > 0 ? h(Flag, { warn: true, title: '同名 skill 存在于多个目录，DSH 只采用优先级最高的一份' }, duplicateCount + ' 个同名冲突') : null,
            )
          : null,
      );
    }

    function PreviewPanel(props) {
      const data = props.data;
      const catalog = data.catalog || {};
      const session = data.session || {};
      const [tab, setTab] = react.useState(session.published ? 'actual' : 'next');
      const text = tab === 'actual' ? (session.preview || '（本会话还没有发布过技能目录）') : (catalog.preview || '');
      return h('div', { className: 'sh-panel' },
        h('div', { className: 'sh-row' },
          h('div', { className: 'sh-name' }, '模型看到的技能目录'),
          h('div', { className: 'sh-grow' }),
          h('button', { className: 'sh-tab' + (tab === 'actual' ? ' on' : ''), onClick: () => setTab('actual') },
            '本会话已发布' + (session.published ? '（≈' + fmtTok(session.tokens) + ' tok）' : '')),
          h('button', { className: 'sh-tab' + (tab === 'next' ? ' on' : ''), onClick: () => setTab('next') },
            '下次发布预演' + (catalog.visible ? '（≈' + fmtTok(catalog.tokens) + ' tok）' : '')),
          h('button', { className: 'sh-btn sh-btn-sm', onClick: props.onClose }, '关闭'),
        ),
        h('div', { className: 'sh-hint', style: { marginTop: 6 } },
          tab === 'actual'
            ? '这是本会话里模型真实收到的那条消息（最近一次发布）。历史中每次目录变更都会追加一份完整副本，旧的不会删除。'
            : '按当前配置与注册表推算的下一条目录消息；描述按上限截断、特殊字符已转义。',
        ),
        h('pre', { className: 'sh-pre' }, text),
      );
    }

    function SkillCard(props) {
      const row = props.row;
      const isOpen = props.open && props.open.name === row.name;
      const [del, setDel] = useState('idle');
      const [delMsg, setDelMsg] = useState(null);
      const [hideBusy, setHideBusy] = useState(false);
      const [hideMsg, setHideMsg] = useState(null);

      async function doDelete() {
        if (del === 'idle') { setDel('confirm'); return; }
        if (del !== 'confirm') return;
        setDel('busy');
        setDelMsg(null);
        try {
          const res = await rpc('delete-skill', props.rpcArgs({ name: row.name }));
          if (res && res.ok) {
            setDel('done');
            setDelMsg({ ok: true, text: (res.wasSymlink ? '已移除软链接: ' : '已删除: ') + res.removed });
            if (props.onDeleted) props.onDeleted();
          } else {
            setDel('idle');
            setDelMsg({ ok: false, text: (res && res.error) || '删除失败' });
          }
        } catch (e) {
          setDel('idle');
          setDelMsg({ ok: false, text: String((e && e.message) || e) });
        }
      }

      async function toggleVisible() {
        setHideBusy(true);
        setHideMsg(null);
        try {
          const res = await rpc('set-model-invocation', props.rpcArgs({ name: row.name, enabled: !row.visible }));
          if (res && res.ok) {
            setHideMsg({ ok: true, text: res.unchanged ? '内容未变化' : (row.visible ? '已隐藏：文件保留，不再进入模型目录' : '已恢复：下次请求会重新出现在目录中') });
            if (props.onToggled) props.onToggled();
          } else {
            setHideMsg({ ok: false, text: (res && res.error) || '操作失败' });
          }
        } catch (e) {
          setHideMsg({ ok: false, text: String((e && e.message) || e) });
        }
        setHideBusy(false);
      }

      return h('div', { className: 'sh-card' + (row.visible ? '' : ' sh-dim') },
        h('div', { className: 'sh-row', style: { gap: 6, marginBottom: 2 } },
          h('div', { className: 'sh-name' }, row.name),
          row.source ? h('span', { className: 'sh-src' }, SOURCE_LABELS[row.source] || row.source) : null,
          h(CostBadge, { tokens: row.tokens, visible: row.visible }),
          row.truncated ? h(Flag, { warn: true, title: '介绍超过 ' + (props.cap || 500) + ' 字符，模型只看到截断后的部分' }, '截断') : null,
          !row.visible ? h(Flag, { hide: true }, '已隐藏') : null,
          (row.reasons || []).indexOf('big-body') !== -1 ? h(Flag, { warn: true, title: '正文 ' + fmtBytes(row.bodyBytes) + '，加载一次会长期占用历史' }, '正文偏大') : null,
          (row.duplicates || []).length > 0 ? h(Flag, { warn: true, title: '同名 skill 还存在于: ' + row.duplicates.map((d) => d.entryFile || d.dir || d.root).join('  ') }, '冲突') : null,
          row.sessionOnly ? h(Flag, { warn: Boolean(row.stale), title: row.stale ? '磁盘上已没有它，但本会话已发布的目录里还有；下次目录变更后消失' : '只出现在本会话已发布的目录中（磁盘扫描没有找到）' }, row.stale ? '已不在磁盘' : '仅会话目录') : null,
        ),
        row.description
          ? h('div', { className: 'sh-desc' }, row.effective)
          : h('div', { className: 'sh-desc sh-warn' }, '（没有介绍，模型无法据此判断何时使用）'),
        row.truncated
          ? h('div', { className: 'sh-hint', style: { marginTop: 2 } },
              '原始介绍 ' + row.description.length + ' 字符，模型只看到前 ' + Math.max(0, (props.cap || 500) - 3) + ' 字符。')
          : null,
        row.entryFile
          ? h('div', { className: 'sh-meta' },
              h('div', null, '路径: ' + (row.dir || row.entryFile)),
              row.linkTarget ? h('div', null, '软链接目标: ' + row.linkTarget + '  →  ' + (row.realDir || '')) : null,
              h('div', null, '正文: ' + fmtBytes(row.bodyBytes) + (row.bodyBytes ? '（加载一次 ≈' + fmtTok(row.bodyTokens) + ' tok，长期留在历史）' : '')),
            )
          : h('div', { className: 'sh-meta' }, '会话级 / 注册表条目：没有可直接管理的本地文件'),
        (row.files || []).length > 0
          ? h('div', { className: 'sh-files' }, row.files.map((f) => h('span', { key: f, className: 'sh-chip' }, f)))
          : null,
        h('div', { className: 'sh-row', style: { marginTop: 8 } },
          row.entryFile
            ? h('button', { className: 'sh-btn', onClick: props.onView }, isOpen ? '关闭' : '查看 SKILL.md')
            : null,
          row.entryFile && row.inCatalog && row.writable
            ? h('button', {
                className: 'sh-btn',
                disabled: hideBusy,
                title: row.visible ? '写入 disable-model-invocation: true，把该 skill 从模型目录摘掉（文件保留）' : '移除 disable-model-invocation，恢复进入模型目录',
                onClick: toggleVisible,
              }, hideBusy ? '写入中…' : (row.visible ? '从目录隐藏' : '恢复到目录'))
            : null,
          row.deletable
            ? h('button', {
                className: 'sh-btn sh-btn-danger',
                disabled: del === 'busy' || del === 'done',
                onClick: doDelete,
              }, del === 'confirm' ? '确认删除该 Skill？' : del === 'busy' ? '删除中…' : del === 'done' ? '已删除' : '删除 Skill')
            : null,
          !row.writable && row.entryFile
            ? h('span', { className: 'sh-hint' }, '受保护目录（' + (SOURCE_LABELS[row.source] || row.source) + '），请在来源处管理')
            : null,
        ),
        del === 'confirm' && row.linkTarget
          ? h('div', { className: 'sh-hint', style: { marginTop: 4 } }, '该 skill 是软链接：删除仅移除链接本身，不会删除目标文件。')
          : null,
        del === 'confirm' && !row.linkTarget
          ? h('div', { className: 'sh-hint', style: { marginTop: 4 } }, '将删除该 skill 的文件目录；仅影响这一个 skill，不会影响 Skills Hub 插件本身。')
          : null,
        delMsg ? h('div', { className: delMsg.ok ? 'sh-ok' : 'sh-error', style: { marginTop: 4 } }, delMsg.text) : null,
        hideMsg ? h('div', { className: hideMsg.ok ? 'sh-ok' : 'sh-error', style: { marginTop: 4 } }, hideMsg.text) : null,
        isOpen ? h(OpenSkill, { open: props.open }) : null,
      );
    }

    function OpenSkill(props) {
      const o = props.open;
      if (o.loading) return h('div', { className: 'sh-hint', style: { marginTop: 8 } }, '读取中…');
      if (o.note) return h('div', { className: 'sh-error', style: { marginTop: 8 } }, o.note);
      return h('div', null,
        h('div', { className: 'sh-meta' }, o.file || ''),
        h('pre', { className: 'sh-pre' }, o.content),
        o.truncated ? h('div', { className: 'sh-hint' }, '（内容过长，已截断显示前 200KB）') : null,
      );
    }

    function Diagnostics(props) {
      const items = props.items || [];
      if (items.length === 0) return null;
      return h('div', { className: 'sh-panel' },
        h('div', { className: 'sh-name' }, '没有进入模型目录的 skill（' + items.length + '）'),
        h('div', { className: 'sh-hint', style: { marginTop: 4 } }, 'DSH 对无效或不参与模型调用的 skill 不做提示；这里列出原因，便于排查为什么上下文里看不到它。'),
        h('div', { style: { marginTop: 8 } },
          items.map((item) => h('div', { className: 'sh-diag', key: item.name + ':' + item.reason },
            h('span', { className: 'sh-diag-r' }, DIAG_LABELS[item.reason] || item.reason),
            h('span', { className: 'sh-name', style: { fontSize: 12 } }, item.name),
            h('span', { className: 'sh-hint sh-grow' }, item.detail),
          )),
        ),
      );
    }

    function ImportResult(props) {
      const r = props.r || {};
      if (!r.ok) {
        return h('div', { className: 'sh-card' }, h('div', { className: 'sh-error' }, '导入失败: ' + (r.error || '未知错误')));
      }
      const items = Array.isArray(r.results) ? r.results : [];
      return h('div', { className: 'sh-card' },
        h('div', { className: 'sh-ok' }, '导入完成'),
        h('div', { className: 'sh-meta' }, '安装目录: ' + (r.installRoot || '')),
        h('div', { className: 'sh-hint', style: { marginTop: 4 } }, '新 skill 会进入下一次模型请求的技能目录；文案越长，每次请求的固定开销越大。'),
        items.map((it, i) => h('div', { key: i, className: 'sh-section' },
          h('div', { className: 'sh-name' }, it.name + (it.version ? '  ·  v' + it.version : '')),
          h('div', { className: 'sh-meta' }, it.dir || ''),
          h('div', { className: 'sh-files' },
            (it.files || []).slice(0, 12).map((f) => h('span', { key: f, className: 'sh-chip' }, f)),
            (it.files || []).length > 12 ? h('span', { className: 'sh-chip' }, '… 共 ' + it.files.length + ' 个文件') : null,
          ),
          it.security ? h('div', { className: 'sh-hint' }, 'ClawHub 安全扫描: ' + it.security) : null,
          it.changelog ? h('div', { className: 'sh-hint' }, '更新日志: ' + String(it.changelog).slice(0, 200)) : null,
          (it.warnings || []).length > 0
            ? h('div', { className: 'sh-error', style: { marginTop: 4 } }, '警告: ' + it.warnings.join('; '))
            : null,
        )),
      );
    }

    function SkillsHubPage(props) {
      const provider = props && typeof props.projectPathProvider === 'function' ? props.projectPathProvider : null;
      const sessionIdOf = props && typeof props.sessionIdProvider === 'function' ? props.sessionIdProvider : null;
      const rpcArgs = (extra) => {
        const out = Object.assign({}, extra || {});
        const cwd = provider ? provider() : null;
        if (cwd) out.cwd = cwd;
        const sid = sessionIdOf ? sessionIdOf() : null;
        if (sid) out.sessionId = sid;
        return out;
      };

      const [tab, setTab] = useState('browse');
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState('');
      const [bucket, setBucket] = useState('all');
      const [open, setOpen] = useState(null);
      const [preview, setPreview] = useState(false);
      const [sortBy, setSortBy] = useState('name');
      const [targets, setTargets] = useState(null);
      const [form, setForm] = useState({ url: '', target: 'user' });
      const [importing, setImporting] = useState(false);
      const [importResult, setImportResult] = useState(null);

      useEffect(() => {
        refresh();
        rpc('resolve-target', rpcArgs()).then((t) => { if (t && t.ok) setTargets(t); }).catch(() => {});
      }, []);

      async function refreshTargets() {
        try {
          const t = await rpc('resolve-target', rpcArgs());
          if (t && t.ok) setTargets(t);
        } catch (e) { /* ignore */ }
      }

      async function refresh() {
        setBusy(true);
        setError('');
        try {
          const res = await rpc('overview', rpcArgs());
          if (res && res.ok) setData(res);
          else setError((res && res.error) || '读取失败');
        } catch (e) {
          setError(String((e && e.message) || e));
        }
        setBusy(false);
      }

      async function viewSkill(row) {
        if (open && open.name === row.name) { setOpen(null); return; }
        if (!row.entryFile) { setOpen({ name: row.name, note: '没有可显示的文件路径' }); return; }
        setOpen({ name: row.name, loading: true });
        try {
          const res = await rpc('read-file', rpcArgs({ path: row.entryFile }));
          const file = row.entryFile.split('/').pop();
          setOpen(res && res.ok
            ? { name: row.name, file, content: res.content, truncated: res.truncated }
            : { name: row.name, file, note: (res && res.error) || '读取失败' });
        } catch (e) {
          setOpen({ name: row.name, note: String((e && e.message) || e) });
        }
      }

      async function doImport() {
        if (!form.url.trim()) return;
        setImporting(true);
        setImportResult(null);
        try {
          const res = await rpc('import-skill', rpcArgs({ url: form.url.trim(), target: form.target }));
          setImportResult(res || { ok: false, error: '无响应' });
          refresh();
          setTimeout(() => { refresh(); }, 1200);
        } catch (e) {
          setImportResult({ ok: false, error: String((e && e.message) || e) });
        }
        setImporting(false);
      }

      function afterToggle() {
        refresh();
        setTimeout(() => { refresh(); }, 1000);
      }

      const rows = data ? (data.rows || []) : null;
      const q = query.trim().toLowerCase();
      const counts = { all: rows ? rows.length : 0, builtin: 0, 'third-party': 0 };
      if (rows) for (const r of rows) counts[bucketOf(r)] += 1;
      const filtered = rows
        ? rows.filter((r) => (bucket === 'all' || bucketOf(r) === bucket)
            && (!q || (r.name || '').toLowerCase().indexOf(q) !== -1 || (r.description || '').toLowerCase().indexOf(q) !== -1))
        : null;
      if (filtered && sortBy === 'cost') filtered.sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
      const src = detectSource(form.url);

      function browseView() {
        return h(Fragment, null,
          h('div', { className: 'sh-row' },
            h('input', {
              className: 'sh-input sh-grow',
              placeholder: '按名称或介绍搜索已安装 Skills…',
              value: query, onChange: (e) => setQuery(e.target.value),
            }),
            h('button', { className: 'sh-btn', disabled: busy, onClick: refresh }, busy ? '刷新中…' : '刷新'),
          ),
          error ? h('div', { className: 'sh-error' }, error) : null,
          data && data.scanError
            ? h('div', { className: 'sh-error' }, '技能目录扫描失败: ' + data.scanError)
            : null,
          rows !== null && rows.length > 0
            ? h('div', { className: 'sh-row', style: { gap: 6 } },
                BUCKETS.map((b) => h('button', {
                  key: b.id,
                  className: 'sh-tab sh-tab-sm' + (bucket === b.id ? ' on' : ''),
                  title: b.hint,
                  onClick: () => setBucket(b.id),
                }, b.label, h('span', { className: 'sh-count' }, String(counts[b.id])))),
              )
            : null,
          rows === null
            ? h('div', { className: 'sh-hint' }, '加载中…')
            : rows.length === 0
            ? h('div', { className: 'sh-panel' },
                h('div', { className: 'sh-name' }, '还没有安装任何 skill'),
                h('div', { className: 'sh-hint', style: { marginTop: 4 } }, '在「从 URL 导入」里粘贴 ClawHub / Skills.sh / GitHub 链接，或把 skill 目录放到 ' + ((data && data.scope && data.scope.projectSkillsDir) || '.dsh/skills') + ' 下。'),
              )
            : h('div', { className: 'sh-list' },
                h('div', { className: 'sh-hint' }, q
                  ? '匹配 ' + filtered.length + ' / ' + rows.length + ' 个 skill'
                  : bucket === 'all'
                    ? '共 ' + rows.length + ' 个 skill' + (data && data.scope && data.scope.projectSkillsDir ? ' · 项目目录 ' + data.scope.projectSkillsDir : '')
                    : (bucket === 'builtin' ? '内置' : '第三方') + ' ' + filtered.length + ' 个 / 共 ' + rows.length + ' 个'),
                filtered.length === 0
                  ? h('div', { className: 'sh-panel' },
                      h('div', { className: 'sh-name' }, bucket === 'builtin' ? '没有内置 skill' : '没有第三方 skill'),
                      h('div', { className: 'sh-hint', style: { marginTop: 4 } },
                        bucket === 'builtin'
                          ? '内置 skill 随 DSH、插件或 Agent 预设一起安装。'
                          : '第三方 skill 装在项目 .dsh/skills、~/.dsh/skills 或 ~/.agents/skills 下，可在「从 URL 导入」里添加。'),
                    )
                  : null,
                filtered.map((row) => h(SkillCard, {
                  key: row.name,
                  row,
                  open,
                  cap: data ? data.cap : 500,
                  onView: () => viewSkill(row),
                  onDeleted: refresh,
                  onToggled: afterToggle,
                  rpcArgs,
                })),
              ),
          data ? h(Diagnostics, { items: data.diagnostics || [] }) : null,
        );
      }

      function importView() {
        return h('div', { className: 'sh-wrap' },
          h('div', { className: 'sh-hint' }, '输入已发布 skill 的链接，由服务端拉取文件并写入所选目录：'),
          h('input', {
            className: 'sh-input',
            placeholder: 'clawhub.ai/<owner>/<skill>  或  skills.sh/<owner>/<repo>/<skill>  或  github.com/<owner>/<repo>',
            value: form.url, onChange: (e) => setForm(Object.assign({}, form, { url: e.target.value })),
          }),
          src ? h('div', { className: 'sh-hint' }, '识别来源: ' + src) : null,
          h('div', { className: 'sh-section' },
            h('div', { className: 'sh-sec-title' }, '安装位置'),
            h('label', { className: 'sh-row', style: { cursor: 'pointer' } },
              h('input', {
                type: 'radio', checked: form.target === 'user',
                onChange: () => setForm(Object.assign({}, form, { target: 'user' })),
              }),
              h('span', null, '用户技能目录（全局）'),
              targets ? h('span', { className: 'sh-meta' }, targets.user) : null,
            ),
            h('label', { className: 'sh-row', style: { cursor: 'pointer' } },
              h('input', {
                type: 'radio', checked: form.target === 'project',
                onChange: () => setForm(Object.assign({}, form, { target: 'project' })),
              }),
              h('span', null, '当前项目（.dsh/skills）'),
              targets ? h('span', { className: 'sh-meta' }, targets.project) : null,
            ),
          ),
          h('div', { className: 'sh-hint', style: { marginTop: 4 } },
            '装进项目目录的 skill 只对「项目根 = 该目录」的会话可见；描述写得越短，每次请求的目录开销越小。'),
          h('button', {
            className: 'sh-btn sh-btn-primary', disabled: importing || !form.url.trim(), onClick: doImport,
          }, importing ? '导入中…' : '导入'),
          importResult ? h(ImportResult, { r: importResult }) : null,
        );
      }

      return h('div', { className: 'sh-wrap' },
        h('div', { className: 'sh-tabs' },
          h('button', { className: 'sh-tab' + (tab === 'browse' ? ' on' : ''), onClick: () => { setTab('browse'); refreshTargets(); refresh(); } }, '已安装 Skills'),
          h('button', { className: 'sh-tab' + (tab === 'import' ? ' on' : ''), onClick: () => { setTab('import'); refreshTargets(); } }, '从 URL 导入'),
        ),
        tab === 'browse' && data ? h(Summary, {
          data,
          sortBy,
          onToggleSort: () => setSortBy(sortBy === 'cost' ? 'name' : 'cost'),
          onPreview: () => setPreview(!preview),
        }) : null,
        tab === 'browse' && preview && data ? h(PreviewPanel, { data, onClose: () => setPreview(false) }) : null,
        tab === 'browse' ? browseView() : importView(),
      );
    }

    exports.inject = ['slots', 'workspaces', 'sessions'];
    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      const disposeCss = injectCss('dsh-skills-hub/styles', css);
      ctx.effect(() => () => { if (disposeCss !== undefined) disposeCss(); });
      let workspacesList = null;
      let sessionsList = null;
      try {
        const workspaces = ctx.get('workspaces');
        const list = workspaces && workspaces.list;
        if (list && typeof list.getSnapshot === 'function') workspacesList = list;
      } catch (e) { /* ignore */ }
      try {
        const sessions = ctx.get('sessions');
        const list = sessions && sessions.list;
        if (list && typeof list.getSnapshot === 'function') sessionsList = list;
      } catch (e) { /* ignore */ }
      // 每次 RPC 前实时读取：优先当前会话 cwd（随会话切换），回退最近工作区路径
      const projectPathProvider = () => {
        if (sessionsList !== null) {
          try {
            const snap = sessionsList.getSnapshot();
            const summary = snap && snap.current && snap.byId ? snap.byId[snap.current] : null;
            if (summary && typeof summary.cwd === 'string' && summary.cwd) return summary.cwd;
          } catch (e) { /* ignore */ }
        }
        if (workspacesList !== null) {
          try {
            const snap = workspacesList.getSnapshot();
            if (snap && Array.isArray(snap.items)) {
              const w = snap.items.find((x) => x && x.id === snap.recentWorkspaceId) || snap.items.find((x) => x && typeof x.path === 'string');
              if (w && typeof w.path === 'string') return w.path;
            }
          } catch (e) { /* ignore */ }
        }
        return null;
      };
      const sessionIdProvider = () => {
        if (sessionsList === null) return null;
        try {
          const snap = sessionsList.getSnapshot();
          return snap && typeof snap.current === 'string' ? snap.current : null;
        } catch (e) { return null; }
      };
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'skills-hub', order: 30, label: 'Skills Hub' },
        (props) => h(SkillsHubPage, Object.assign({}, props, { projectPathProvider, sessionIdProvider })),
      ));
    };

    return module.exports;
  },
});
