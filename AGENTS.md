# AGENTS.md

> 跨工具 agent 指令。Copilot / Claude Code / Codex / opencode 都读这个文件。
> 只写「删掉它 agent 就会犯错」的内容；任务专属的放 `.github/skills/`。

## 这是什么项目

<!-- TODO: 一到两句话说清目的和当前阶段，不要贴架构图 -->

- 技术栈：Java 21 / Spring Boot 3.3 / PostgreSQL / Kubernetes
- 部署：K8s，dev 与 prod 两个命名空间，镜像通过内部 registry
- 团队约定：分支 `feat|fix|chore/<简短描述>`，提交信息用 Conventional Commits（英文）

## 代码地图

| 路径 | 放什么 |
|---|---|
| `src/main/java/.../api/` | 对外 HTTP 接口，只做参数校验和编排 |
| `src/main/java/.../service/` | 业务逻辑，可单测，不依赖容器 |
| `src/main/java/.../repository/` | 持久化，SQL 只在这里出现 |
| `src/main/resources/db/migration/` | Flyway 迁移，**只增不改** |
| `k8s/` | 部署清单，按环境分目录 |

<!-- TODO: 按实际结构调整，但保持这张表能一屏看完 -->

## 怎么工作

```bash
./mvnw -q -DskipTests compile      # 编译
./mvnw -q test                     # 全部单测
./mvnw -q test -Dtest=OrderServiceTest   # 单个测试
./mvnw -q spotless:apply           # 格式化（不要手改格式）
```

**怎么验证你的改动**（改完必须跑，不许只看代码就说没问题）：

1. `./mvnw -q -DskipTests compile` —— 编译不过说明签名或依赖错了
2. `./mvnw -q test -Dtest=<改到的模块>` —— 先跑相关测试
3. 涉及接口签名/返回结构变化时，跑 `./mvnw -q test` 全量
4. 涉及 K8s 清单改动时，用 `kubectl apply --dry-run=server -f k8s/<env>/` 验证

跑不了的（需要集群、需要内网）就明说「未验证 + 原因」，不要编造运行结果。

## 边界

- **只读集群**：可以 `kubectl get / describe / logs / events`，不允许 `delete / exec / apply / patch / scale / drain`。需要改动时给出命令让人类执行。
- **数据库**：可以读 schema 和查数（只读账号），不允许在 dev 以外执行 DDL/DML。
- **迁移文件**：已合入的 Flyway 脚本不改，要改就新增一个版本。
- **不要**重构任务范围外的代码、不要顺手升级依赖、不要改格式化风格。

## 记忆

如果仓库里有 `.copilot/memory/MEMORY.md`：会话开始时它的标题清单会被自动注入（`sessionStart` 钩子）；没注入就自己读一遍 `## ` 开头的行。清单只是目录——命中相关条目再展开全文。里面的决定优先于你的默认做法。

## 更细的东西在哪

- K8s 排障流程 → `/k8s-triage`（`.github/skills/k8s-triage/SKILL.md`）
- 记忆写入规则 → `.github/copilot-instructions.md`
- 长流程 SOP（迁移手册、发布步骤）→ 建议单独放 `.github/skills/`，**不要写进本文件**
