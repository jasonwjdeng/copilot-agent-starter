#!/usr/bin/env node
/**
 * sessionStart 钩子：把 MEMORY.md 的标题清单注入会话上下文。
 *
 * 解决的问题：记忆是"拉取式"的 —— 只有 agent 主动 memory_search 才会出现，
 * 可它不知道该搜什么词。于是「存了 50 条、实际生效 3 条」成了常态。
 * 这个钩子在会话开始前把目录递到手上：先给菜单，命中再展开全文。
 *
 * 只注入标题（## 开头），不注入正文：标题是固定成本，正文随条数线性增长，
 * 而绝大多数条目和当前任务无关。
 *
 * 契约：stdout 只输出一个 JSON 对象。没有记忆时输出 {}（保持安静）。
 *
 * 自测（不依赖 VS Code）：
 *   node .github/hooks/session-start-memory.cjs --print
 *   MEMORY_ROOT=/tmp/x node .github/hooks/session-start-memory.cjs --print
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ENTRIES = 30; // 超过就该淘汰或分层了，硬顶在这里
const MAX_TOTAL_CHARS = 1500;
const MAX_TITLE_LEN = 60;
const RECENT_LOGS = 3;

/**
 * 找出记忆库位置。优先级：
 *   1. MEMORY_ROOT 环境变量（显式指定）
 *   2. 仓库级安装：<repo>/.copilot/memory
 *   3. 用户级安装：~/.copilot/memory（再挑本项目分区）
 */
/**
 * 向上找仓库根：以 .git 或 .copilot 为标志。找不到就退回脚本所在位置。
 * 用 cwd 而不是 __dirname 优先，是因为钩子的 cwd 就是工作区根，
 * 而脚本可能被别处复制引用。
 */
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.copilot'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveStores() {
  const stores = [];
  const repoRoot = findRepoRoot(process.cwd()) || findRepoRoot(__dirname) || path.resolve(__dirname, '..', '..');

  const envRoot = process.env.MEMORY_ROOT;
  if (envRoot) stores.push({ label: 'MEMORY_ROOT', dir: envRoot });

  stores.push({ label: 'repo', dir: path.join(repoRoot, '.copilot', 'memory') });
  stores.push({ label: 'repo', dir: path.join(process.cwd(), '.copilot', 'memory') });

  const home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  const shared = path.join(home, 'memory');
  if (fs.existsSync(shared)) {
    stores.push({ label: 'global', dir: path.join(shared, 'global') });
    const projectDir = pickProjectPartition(shared, repoRoot);
    if (projectDir) stores.push({ label: 'project', dir: projectDir });
  }
  return stores;
}

/**
 * 复刻 copilot-memory-kit 的项目分区命名：<slug(目录名)>-<sha1(绝对路径) 前 6 位>。
 * 精确匹配优先，避免仓库名互为前缀时（api / api-gateway）串到别人的记忆。
 */
function slugifyName(name) {
  return name
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function projectIdFor(repoRoot) {
  const override = (process.env.MEMORY_PROJECT || '').trim();
  if (override) return slugifyName(override);
  try {
    const absolute = fs.realpathSync(repoRoot);
    const digest = crypto.createHash('sha1').update(absolute, 'utf8').digest('hex').slice(0, 6);
    return `${slugifyName(path.basename(repoRoot))}-${digest}`;
  } catch {
    return null;
  }
}

function pickProjectPartition(shared, repoRoot) {
  const projectsDir = path.join(shared, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  // 1) 精确命中
  const exact = projectIdFor(repoRoot);
  if (exact) {
    const exactDir = path.join(projectsDir, exact);
    if (fs.existsSync(exactDir)) return exactDir;
  }

  // 2) 退化：按 <name> 或 <name>- 前缀找，多个取最近修改的。
  //    仅在 kit 的分区命名规则变过、或 MEMORY_PROJECT 与目录名不一致时才会走到。
  const name = slugifyName(path.basename(repoRoot)).toLowerCase();
  if (!name) return null;

  let candidates;
  try {
    candidates = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          (d.name.toLowerCase() === name || d.name.toLowerCase().startsWith(`${name}-`))
      )
      .map((d) => path.join(projectsDir, d.name));
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const mtime = (p) => {
    try {
      return fs.statSync(path.join(p, 'MEMORY.md')).mtimeMs;
    } catch {
      return 0;
    }
  };
  return candidates.sort((a, b) => mtime(b) - mtime(a))[0];
}

/** 抽 ## 标题，跳过代码块里的伪标题（和 server 的解析口径一致）。 */
function extractTitles(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const titles = [];
  let inFence = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line.startsWith('## ')) continue;

    let title = line.slice(3).trim();
    if (!title) continue;
    if (title.length > MAX_TITLE_LEN) title = title.slice(0, MAX_TITLE_LEN - 1) + '…';
    titles.push(title);
  }
  return titles;
}

/** 最近的几个日期日志，只报文件名，方便"接着上次干"。 */
function recentLogs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, RECENT_LOGS);
  } catch {
    return [];
  }
}

function build() {
  const blocks = [];
  const seen = new Set();
  let total = 0;

  for (const store of resolveStores()) {
    if (!fs.existsSync(store.dir)) continue;

    // MEMORY_ROOT、repo、cwd 可能指向同一个目录，去重后只注入一次
    let key;
    try {
      key = fs.realpathSync(store.dir);
    } catch {
      key = path.resolve(store.dir);
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const titles = extractTitles(path.join(store.dir, 'MEMORY.md'));
    const logs = recentLogs(store.dir);
    if (titles.length === 0 && logs.length === 0) continue;

    const lines = [];
    if (titles.length > 0) {
      const shown = titles.slice(0, MAX_ENTRIES);
      lines.push(
        `本仓库有 ${titles.length} 条长期记忆（只列标题；需要哪条用 memory_read 展开，或直接读 MEMORY.md）：`
      );
      let cut = false;
      for (let i = 0; i < shown.length; i += 1) {
        const row = `- ${shown[i]}`;
        if (total + row.length > MAX_TOTAL_CHARS) {
          lines.push(`- …另有 ${titles.length - i} 条未列出，见 MEMORY.md`);
          cut = true;
          break;
        }
        lines.push(row);
        total += row.length;
      }
      if (!cut && titles.length > MAX_ENTRIES) {
        lines.push(`- …另有 ${titles.length - MAX_ENTRIES} 条未列出`);
      }
    }
    if (logs.length > 0) {
      lines.push(`最近的日志：${logs.join('、')}（要看具体做了什么就读它们）`);
    }
    const where = store.label === 'repo' ? '.copilot/memory' : store.dir;
    blocks.push(`<!-- 记忆来源：${where} -->\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n');
}

const text = build();

if (process.argv.includes('--print')) {
  // 人工自测：直接看会注入什么
  process.stdout.write(text ? `\n${text}\n\n` : '(没有找到记忆库，什么都不会注入)\n');
  process.exit(0);
}

if (!text) {
  process.stdout.write('{}');
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    additionalContext:
      '以下是本项目已沉淀的记忆索引。开始非平凡任务前先扫一眼，命中相关的再展开全文；' +
      '索引与你的默认做法冲突时，以记忆为准。\n\n' + text,
  })
);
