#!/usr/bin/env node
// 生成 docs/index.json —— DSH 插件市场索引（format 1）。
//
// 用法：node scripts/make-index.mjs [--check]
//   --check  仅校验当前 docs/index.json 是否与仓库状态一致
//
// 版本号取自 package.json，安装源固定为当前 HEAD 提交，因此请在
// **提交代码之后**再运行本脚本并提交生成结果。

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const REPO = 'https://github.com/xiatian-wuhan/dsh-skills-hub'
const PAGES = 'https://xiatian-wuhan.github.io/dsh-skills-hub'
const INDEX_URL = `${PAGES}/index.json`

const commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()
const committedAt = Number(execSync('git log -1 --format=%ct', { cwd: root, encoding: 'utf8' }).trim())
const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim() !== ''

if (dirty) {
  console.warn('warning: 工作区有未提交改动，索引将指向 HEAD 而不是当前文件内容。')
}

const index = {
  format: 1,
  title: { en: 'Skills Hub', zh: '技能中枢' },
  description: {
    en: 'See what every installed skill costs in the model context, preview the catalog the model actually receives, and hide skills without deleting them.',
    zh: '看清每个 Skill 在模型上下文里的开销，预览模型真正收到的技能目录，并把不需要的从目录中隐藏而不删除文件。',
  },
  metadata: {
    categories: {
      ui: { title: { en: 'Interface', zh: '界面增强' } },
      skills: { title: { en: 'Skills', zh: '技能管理' } },
      context: { title: { en: 'Context', zh: '上下文优化' } },
    },
    labels: {
      'skills': { title: { en: 'Skills', zh: '技能' } },
      'context-budget': { title: { en: 'Context budget', zh: '上下文成本' } },
      'importer': { title: { en: 'Importer', zh: '导入器' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Skills Hub', zh: '技能中枢' },
      description: {
        en: 'Browse installed skills with their real context cost, preview the exact catalog the model receives, hide skills from the catalog without deleting them, search, and import from ClawHub / Skills.sh / GitHub.',
        zh: '浏览已安装 Skills 及其真实上下文成本，预览模型实际收到的目录原文，一键从目录隐藏（保留文件），支持搜索与从 ClawHub / Skills.sh / GitHub 导入。',
      },
      icon: 'icon.svg',
      author: 'xiatian-wuhan',
      homepage: REPO,
      repository: { url: REPO },
      metadata: {
        category: 'ui',
        keywords: ['dsh', 'dsh-plugin', 'skills', 'skill-hub', 'context', 'clawhub', 'skills-sh'],
        labels: ['skills', 'context-budget', 'importer'],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: committedAt,
          source: {
            type: 'git',
            url: `${REPO}.git`,
            commit,
          },
          engines: { dsh: '>=0.2.0' },
        },
      ],
    },
  ],
}

const out = join(root, 'docs', 'index.json')
const text = `${JSON.stringify(index, null, 2)}\n`

if (process.argv.includes('--check')) {
  const current = (() => { try { return readFileSync(out, 'utf8') } catch { return '' } })()
  if (current !== text) {
    console.error('docs/index.json 已过期：请运行 node scripts/make-index.mjs')
    process.exit(1)
  }
  console.log('docs/index.json 是最新的')
  process.exit(0)
}

writeFileSync(out, text)
console.log(`wrote docs/index.json  ${pkg.name}@${pkg.version}  ${commit.slice(0, 8)}`)
console.log(`index url: ${INDEX_URL}`)
