# copilot-agent-starter

公司电脑上给 VS Code + GitHub Copilot 配一套**只读、可核查、不占上下文**的 agent 骨架。

**是什么**：一份可以直接复制进仓库的模板 —— 精简的指令层、一个 K8s 排障技能、一个只读 MCP 配置、一个拦截危险命令的钩子、一段终端白名单设置。

**不是什么**：不是记忆系统（那是 `../copilot-memory-kit`），不是 MCP 服务器，没有脚本要装，没有 `npx` 以外的新依赖。

---

## 为什么是这几样

2026 年 VS Code 的扩展面有五层，越往下越少人用，但杠杆越大：

| 层 | 是什么 | 本模板给什么 |
|---|---|---|
| 0 内置工具 | `#web/fetch`、集成浏览器、shell | 不提供文件，直接用（见下文「先别装」） |
| 1 MCP | 外部系统接入（你的 K8s MCP 在这层） | `.vscode/mcp.json`：只读模式 |
| 2 插件包 | skills + MCP + agent + hooks 打包 | 不提供（团队统一时才需要） |
| 3 Skills / agent / hooks | 纯文件、按需加载、可确定性执行 | `SKILL.md` + `guard-kubectl` 钩子 |
| 4 环境层 | harness、审批、沙箱、策略 | `snippets/settings.jsonc` |

**核心取舍**：常驻上下文的只有 `AGENTS.md` + `copilot-instructions.md` 两个小文件（合计约 60 行）。剩下的全部走「按需加载」或「确定性执行」——不挤占指令预算。

---

## 文件清单

| 文件 | 作用 | 怎么启用 | 必选 |
|---|---|---|---|
| `AGENTS.md` | 跨工具指令（Copilot / Claude Code / Codex 都读），只放 WHAT/WHY/HOW | 复制到**目标仓库根目录** | ✅ |
| `.github/copilot-instructions.md` | Copilot 专属：记忆指针 + 只读红线，约 20 行 | 复制到目标仓库 `.github/` | ✅ |
| `.github/skills/k8s-triage/SKILL.md` | K8s 排障 SOP，按需加载，不占常驻上下文 | 复制到目标仓库 `.github/skills/` | ✅ |
| `.vscode/mcp.json` | K8s MCP，**只读模式** | 复制到目标仓库 `.vscode/`，重开 VS Code | ✅ |
| `.github/hooks/hooks.json` | 钩子配置：`sessionStart` 注入记忆索引 + `preToolUse` 拦截危险命令 | 与下面两个脚本一起复制到 `.github/hooks/` | 建议 |
| `.github/hooks/guard-kubectl.cjs` | 拦截 `kubectl delete / exec / apply` 等（仅标准库） | 同上 | 建议 |
| `.github/hooks/session-start-memory.cjs` | 会话开始注入 `MEMORY.md` 的标题清单（仅标准库） | 同上 | 建议 |
| `snippets/settings.jsonc` | 终端白名单 / 沙箱 / 审批设置片段 | 手动合并进用户或工作区 `settings.json` | 建议 |

> 除 `.vscode/mcp.json` 和 hooks 外，其余文件复制过去也不会影响别人——但它们**会进 git**，提交前确认团队接受。

### 关于 `.vscode/mcp.json` 里的 server 选择

默认用 `@dockndevai/mcp-kubernetes`，因为它是少数**自带只读模式**（`K8S_MODE=read-only`）的实现——工具表里根本没有写操作，第一道锁才成立。

换成更常见的 `Flux159/mcp-server-kubernetes` 也能用，但它**没有只读开关**，`kubectl_delete` / `kubectl_exec` 会直接出现在工具表里，只剩钩子和审批两道。在能改 MCP 配置的人手里，这两道都可能被绕过——所以模板不给这个默认值。

Windows 上如果 `npx` 起不来，把 `command` 改成 `cmd`、`args` 前面加 `/c`。
内网 air-gapped 时 `npx` 拉不到包：预装到本地后，`command` 直接写 `node`、`args` 写包内入口的绝对路径。


---

## 三道只读锁（缺一道就不算安全）

一个能 list pods 的 MCP，同一个 server 往往也能 `kubectl delete`。它用的是**你的 kubeconfig**，一条命令就是生产事故。所以三道一起上：

1. **服务端只读**：`mcp.json` 里 `K8S_MODE=read-only`。工具注册表里直接没有写操作，这是最硬的一道。
2. **审批不自动化**：`chat.tools.eligibleForAutoApproval` 里把这个 server 的工具设为 `false`，确认框里连「总是允许」都不出现。
3. **钩子兜底**：`guard-kubectl.cjs` 在 `preToolUse` 阶段检查参数，命中 `delete/exec/apply/patch/scale/drain/cordon` 就返回 `deny`。前两道防的是「正常情况」，这道防的是「模型换了个工具名绕过去」。

---

## 15 分钟落地

```bash
# 1. 复制到你的仓库（示例）
cd /path/to/your-repo
cp -R ~/Documents/workspace/tools/copilot-agent-starter/{AGENTS.md,.github,.vscode} .

# 2. 确认 Node 可用（钩子和 MCP 都要）
node --version && npx --version

# 3. 把 snippets/settings.jsonc 里的三项合并进 settings.json

# 4. 重开 VS Code → 命令面板 → MCP: List Servers → 启动 kubernetes
```

然后在 Copilot Chat 里（**确认 Session Target 选的是 Copilot，不是 Local**）：

```
用 k8s-triage 技能看下 <namespace> 里有没有异常 pod
```

---

## 验证清单

- [ ] `MCP: List Servers` 里 `kubernetes` 是绿色
- [ ] 问「列一下 pod」，工具调用来自 `kubernetes` server，且只出现读类工具
- [ ] 让它「删掉那个 pod」→ 应该被钩子拒绝，或至少弹审批，且审批框里没有「总是允许」
- [ ] `/k8s-triage` 能触发技能（说明 frontmatter 的 `name` 与目录名一致）
- [ ] `node .github/hooks/session-start-memory.cjs --print` 能打出一串记忆标题（没有记忆库时输出「什么都不会注入」）
- [ ] 新开一个会话，问「你知道这个项目有哪些长期记忆」——它应该能报出标题而不是去 `memory_search` 瞎猜
- [ ] `Developer: Open Agent Debug Logs` 里能看到两个钩子的执行记录

---

## 公司电脑注意事项

- **没有 Node**：`npx` 那条路走不通。改用远程 MCP（HTTP/SSE + OAuth，不用本地运行时），或退回纯命令行：让 agent 直接跑 `kubectl`，只靠 `snippets/settings.jsonc` 的终端白名单约束（比 MCP 粗，但零安装）。
- **MCP 被策略拦**：先看 `MCP: List Servers` 有没有你的 server。企业策略相关名字：`chat.mcp.access`、`ChatAllowedMcpServers` / `ChatDeniedMcpServers`、`ChatAllowManagedMcpServersOnly`。找 IT 时报这些名字，比说「我想装个插件」有效。
- **钩子被策略拦**：`ChatAllowManagedHooksOnly` 会只允许企业托管来源的钩子。此时第 3 道锁失效，第 1、2 道必须保证。
- **工具预算**：单请求硬上限 128 个工具，社区经验超过 ~40 个选工具准确率开始掉。K8s server 自带 12–25 个，**别再同时开三四个 MCP**。

---

## 先别装

这两件事不需要 MCP，装了反而占预算：

- 读文档 → `#web/fetch`（内置）
- 验证页面 / 点流程 / 看 console → 内置浏览器工具（官方明确建议优先于 Playwright MCP）

---

## 记忆索引为什么用钩子

`copilot-memory-kit` 的记忆是**拉取式**的：只有 agent 主动 `memory_search` 才会出现。可它不知道该搜什么词——于是「存了 50 条、实际生效 3 条」成了常态。

`session-start-memory.cjs` 在会话开始前把 `MEMORY.md` 的标题清单注入上下文：**先给菜单，命中再展开全文**。三个取舍：

- **只注入标题**，不注入正文。标题是固定成本（30 条约 900 字符），正文随条数线性增长且多数与当前任务无关。
- **用钩子而不是写进指令**。指令是「请求它去读」，占指令预算、可能被忽略、可能读晚；钩子是「读好了递到手上」，每次一致。
- **没有记忆库时输出 `{}`**，保持安静，不制造噪声。

已知边界：

1. 只在**新会话 / 恢复会话**时注入。会话中途写入的记忆，下一次才会出现在索引里。
2. VS Code 的 hooks 仍是 Preview。`sessionStart` 的输出我按 `additionalContext` 实现（与 `postToolUse` 的口径一致），**未在真机验证过 schema**。`--print` 只能证明脚本逻辑对，证明不了 schema 对——看验证清单最后两条。
3. 企业策略 `ChatAllowManagedHooksOnly` 会挡掉非托管钩子，此时退回 `copilot-instructions.md` 里那一行手动读取。
4. 硬上限 **30 条 / 1500 字符**。超过就该做淘汰或分层，否则只是把「记忆太多没人读」换成了「目录太长没人看」。
5. 目录解析顺序：`MEMORY_ROOT` → `<repo>/.copilot/memory` → `~/.copilot/memory/{global,projects/<id>}`，同一个真实路径只注入一次。
6. 用户级安装的分区名 `<slug>-<sha1(绝对路径) 前 6 位>` 是**按 kit 的规则复算**的，不是前缀猜测——否则仓库名互为前缀时（`api` / `api-gateway`）会读到别人的记忆。复算不中才退化到前缀匹配。
