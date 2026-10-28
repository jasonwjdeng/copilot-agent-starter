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
| 1 MCP | 外部系统接入（你的 K8s MCP 在这层） | `.vscode/mcp.json` + `k8s-mcp.toml`：只读 + 资源黑名单 |
| 2 插件包 | skills + MCP + agent + hooks 打包 | 不提供（团队统一时才需要） |
| 3 Skills / agent / hooks | 纯文件、按需加载、可确定性执行 | `SKILL.md` + `guard-kubectl` 钩子 |
| 4 环境层 | harness、审批、沙箱、策略 | `snippets/settings.jsonc` |

**核心取舍**：常驻上下文的只有 `AGENTS.md` + `copilot-instructions.md` 两个小文件（合计约 90 行）。剩下的全部走「按需加载」或「确定性执行」——不挤占指令预算。

---

## 文件清单

| 文件 | 作用 | 怎么启用 | 必选 |
|---|---|---|---|
| `AGENTS.md` | 跨工具指令（Copilot / Claude Code / Codex 都读），只放 WHAT/WHY/HOW | 复制到**目标仓库根目录** | ✅ |
| `.github/copilot-instructions.md` | Copilot 专属：记忆指针 + 只读红线，约 20 行 | 复制到目标仓库 `.github/` | ✅ |
| `.github/skills/k8s-triage/SKILL.md` | K8s 排障 SOP，按需加载，不占常驻上下文 | 复制到目标仓库 `.github/skills/` | ✅ |
| `.vscode/mcp.json` | K8s MCP 客户端配置，`--config` 指向下面那份 TOML | 复制到目标仓库 `.vscode/`，重开 VS Code | ✅ |
| `.vscode/k8s-mcp.toml` | server 的运行时策略：只读、工具组、资源黑名单、确认兜底 | 与 `mcp.json` 一起复制，不用改 | ✅ |
| `.github/hooks/hooks.json` | 钩子配置：`sessionStart` 注入记忆索引 + `preToolUse` 拦截危险命令 | 与下面两个脚本一起复制到 `.github/hooks/` | 建议 |
| `.github/hooks/guard-kubectl.cjs` | 拦截 `kubectl delete / exec / apply` 等（仅标准库） | 同上 | 建议 |
| `.github/hooks/session-start-memory.cjs` | 会话开始注入 `MEMORY.md` 的标题清单（仅标准库） | 同上 | 建议 |
| `snippets/settings.jsonc` | 终端白名单 / 沙箱 / 审批设置片段 | 手动合并进用户或工作区 `settings.json` | 建议 |

> 除 `.vscode/mcp.json` 和 hooks 外，其余文件复制过去也不会影响别人——但它们**会进 git**，提交前确认团队接受。

### 为什么是 `containers/kubernetes-mcp-server`

2,196★，Red Hat 的 `containers` org（Podman 那一伙），Go 原生直连 API server 而不是包一层 kubectl。选它的理由不是星数，是它同时给了两样别人给不全的：

- `read_only = true` 时**写类工具根本不注册**
- `[[denied_resources]]` 能把 `v1/Secret` 整类屏蔽

第二样比第一样重要。**只读限制了「写」，没限制「读」**：`kubectl get secret x -o yaml` 完全合规，base64 解一下就是 token、证书和连接串。一个只有「只读」没有「资源黑名单」的 server，等于把凭证摆在工具的取值范围内。

代价：它的运行时策略**只认 TOML**（`--config`），不读 `K8S_MODE` 这类环境变量。所以多了 `.vscode/k8s-mcp.toml`。改那份文件前记住两个坑（注释里也写了）：未知键会让 server **启动失败**而不是忽略；顶层键必须写在 `[[...]]` 段之前，否则会被归到上一个表里。

顺带解决了工具预算：默认 `toolsets = ["core", "config"]`，工具数比原来那套少，离 128 的上限更远。

**为什么不用别的**：

| 备选 | star | 不选的原因 |
|---|---:|---|
| `Flux159/mcp-server-kubernetes` | 1,610 | 能力其实够（现在有 non-destructive 模式和 secrets 掩码），但有 `CVE-2026-39884`（port_forward 参数注入，CVSS 8.3）。要用必须 ≥ v3.5.0 |
| `rohitg00/kubectl-mcp-server` | 965 | 253 个工具，直接击穿工具预算，选工具的准确率崩掉 |
| `k8sgpt` / `HolmesGPT` / `kubectl-ai` | 8.3k / 3.7k / 7.6k | 星最多，但它们是「诊断流水线」不是工具集，换过去等于把 `k8s-triage` 整份重写 |
| `Azure/mcp-kubernetes` | 61 | 微软官方，社区太薄 |

> 上一版默认的是 `dockndevai/mcp-kubernetes`。它的设计其实更细（read-only / read-write / admin 三档、命名空间允许列表、审计日志），但仓库 2 星、2026-08 才建、0 fork。**设计得好**和**被足够多人审查过**是两件事——在公司电脑上 `npx -y` 时，后者更重要。

Windows 上如果 `npx` 起不来，把 `command` 改成 `cmd`、`args` 前面加 `/c`。
内网 air-gapped 时 `npx` 拉不到包：它是**单二进制**，去 releases 下对应平台的包，`command` 写绝对路径、`args` 只留 `["--config", "<绝对路径>/k8s-mcp.toml"]`——这条路比上一版宽，那个是纯 npm 包，没 Node 就真的没路。


---

## 四道锁（缺一道就不算安全）

一个能 list pods 的 MCP，同一个 server 往往也能 `kubectl delete`。它用的是**你的 kubeconfig**，一条命令就是生产事故。而且「只读」只挡住了写、没挡住读——所以是四道，不是三道：

1. **服务端只读**：`k8s-mcp.toml` 里 `read_only = true`。写类工具不注册，这是最硬的一道。
2. **资源黑名单**：同一份 TOML 里的 `[[denied_resources]]` 屏蔽 `v1/Secret`。它和第一道回答的是不同问题：那道是「不许写」，这道是「连读都不给」。
3. **审批不自动化**：`chat.tools.eligibleForAutoApproval` 里把这个 server 的工具设为 `false`，确认框里连「总是允许」都不出现；TOML 里再配 `confirmation_fallback = "deny"`，让「确认不了」等于拒绝而不是放行。
4. **钩子兜底**：`guard-kubectl.cjs` 在 `preToolUse` 阶段检查参数，命中 `delete/exec/apply/patch/scale/drain/cordon` 或 `get/describe secret` 就返回 `deny`。前三道防的是「正常情况」，这道防的是「模型换了个工具名、或改用 shell 绕过去」。

| 锁 | 拦住什么 | 会被什么绕开 |
|---|---|---|
| ① 服务端只读 | 写操作 | 换一个没设只读的 server |
| ② 资源黑名单 | 读 Secret | 从终端 `kubectl get secret` |
| ③ 审批不自动化 | 顺手点「总是允许」 | 能改配置的人 |
| ④ 钩子 | 上面两条的绕法（含 `pods_delete` 这种下划线工具名） | 企业策略禁用钩子（`ChatAllowManagedHooksOnly`） |

---

## 15 分钟落地

```bash
# 1. 复制到你的仓库（示例）
cd /path/to/your-repo
cp -R ~/Documents/workspace/tools/copilot-agent-starter/{AGENTS.md,.github,.vscode} .

# 2. 确认 Node 可用（钩子必须有；MCP 走 npx 也要，没有 Node 就换单二进制）
node --version && npx --version

# 3. 把 snippets/settings.jsonc 里的四项合并进 settings.json

# 4. 重开 VS Code → 命令面板 → MCP: List Servers → 启动 kubernetes
```

`mcp.json` 里用 `cwd: ${workspaceFolder}` + 相对路径 `.vscode/k8s-mcp.toml`，所以 `.vscode/` 整个目录必须待在工作区根目录下。要挪到别处，把 `cwd` 和 `--config` 一起改成绝对路径。

然后在 Copilot Chat 里（**确认 Session Target 选的是 Copilot，不是 Local**）：

```
用 k8s-triage 技能看下 <namespace> 里有没有异常 pod
```

---

## 验证清单

- [ ] `MCP: List Servers` 里 `kubernetes` 是绿色；工具列表里**一个 delete / apply / exec 都没有**（这是只读模式生效的判据，不是看配置文件）
- [ ] 问「列一下 pod」，工具调用来自 `kubernetes`，工具名形如 `pods_list`
- [ ] 让它「读一下 xxx secret」→ 应该被 **server 直接拒**（不是弹审批、也不是靠钩子）
- [ ] 让它「删掉那个 pod」→ 这个工具不存在；如果它转去用 shell，钩子应拒绝
- [ ] 自测钩子两条，都应输出 deny：
      `echo '{"toolName":"shell","toolArgs":{"command":"kubectl delete pod a"}}' | node .github/hooks/guard-kubectl.cjs`
      `echo '{"toolName":"shell","toolArgs":{"command":"kubectl get secret x -o yaml"}}' | node .github/hooks/guard-kubectl.cjs`
- [ ] `/k8s-triage` 能触发技能（说明 frontmatter 的 `name` 与目录名一致）
- [ ] `node .github/hooks/session-start-memory.cjs --print` 能打出一串记忆标题（没有记忆库时输出「什么都不会注入」）
- [ ] 新开一个会话，问「你知道这个项目有哪些长期记忆」——它应该能报出标题而不是去 `memory_search` 瞎猜
- [ ] `Developer: Open Agent Debug Logs` 里能看到两个钩子的执行记录

---

## 公司电脑注意事项

- **没有 Node**：`npx` 走不通，但**不用退到纯命令行**——`kubernetes-mcp-server` 是单二进制，去 releases 下对应平台的包，MCP 客户端里 `command` 写绝对路径即可，零运行时依赖。（上一版默认那个是纯 npm 包，没 Node 就真的没路。）
- **MCP 被策略拦**：先看 `MCP: List Servers` 有没有你的 server。企业策略相关名字：`chat.mcp.access`、`ChatAllowedMcpServers` / `ChatDeniedMcpServers`、`ChatAllowManagedMcpServersOnly`。找 IT 时报这些名字，比说「我想装个插件」有效。
- **钩子被策略拦**：`ChatAllowManagedHooksOnly` 会只允许企业托管来源的钩子。此时第 3 道锁失效，第 1、2 道必须保证。
- **工具预算**：单请求硬上限 128 个工具，社区经验超过 ~40 个选工具准确率开始掉。当前 `toolsets = ["core", "config"]` 下是十几个，**别再同时开三四个 MCP**。

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
