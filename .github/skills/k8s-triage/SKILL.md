---
name: k8s-triage
description: 在 dev/prod 集群里按固定顺序排查异常 Pod 与服务不可用。当用户说「看下 pod」「为什么重启」「服务 5xx」「发布后不对」时使用。只读排查，产出结论 + 证据 + 下一步，不执行任何写操作。
argument-hint: '[namespace] [pod 或服务名，可省略]'
---

# K8s 排障（只读）

按顺序走，**不要跳步**。每一步都把关键输出留在回答里，不要只说「看起来正常」。

## 0. 先确定三件事

1. **namespace** —— 用户没给就问，不要猜；也**不要默认 `default`**
2. **时间窗** —— 是「一直这样」还是「X 点之后开始」？后者优先查最近变更
3. **症状** —— Pod 起不来 / 重启 / 接口报错 / 变慢，四种走法不同

## 1. 全局扫一遍

```bash
kubectl get pods -n <ns> -o wide
kubectl get pods -n <ns> --field-selector=status.phase!=Running
```

关注三列：`STATUS`、`RESTARTS`、`AGE`。**AGE 很短 + RESTARTS 很高 = 刚崩过**。

## 2. 看事件（最容易被跳过、信息量最大的一步）

```bash
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -40
```

事件里的 `Warning` 按时间倒序读。常见对应：

| 事件关键词 | 指向 |
|---|---|
| `FailedScheduling` | 资源不足 / 亲和性 / 污点 |
| `Failed to pull image` | 镜像名、tag、registry 凭据 |
| `BackOff` + `CrashLoopBackOff` | 容器启动即退出，去看日志 |
| `Unhealthy` | 探针配置或启动太慢 |
| `OOMKilled` | limits 太低或内存泄漏 |
| `FailedMount` | configmap/secret 缺失或挂载路径冲突 |

## 3. 单个 Pod 挖下去

```bash
kubectl describe pod <pod> -n <ns>
kubectl logs <pod> -n <ns> --tail=100
kubectl logs <pod> -n <ns> --tail=100 --previous    # 崩溃前的日志，关键
```

`describe` 只看三块：`Last State`（上次为什么死）、`Events`（和上一步对账）、`Containers` 里的 `Limits/Requests`。

**`--previous` 是排 CrashLoop 的核心**：当前实例可能刚起来还没报错，死因在上一个实例里。

## 4. 资源与依赖

```bash
kubectl top pod -n <ns>              # 需要 metrics-server，没有就跳过并说明
kubectl get svc,endpoints -n <ns>    # endpoints 为空 = 选择器不匹配或 Pod 未就绪
kubectl rollout history deploy/<name> -n <ns>
kubectl get rs -n <ns> -o wide
```

## 5. 找「最近变更」

大部分线上问题来自变更，不是代码本身有 bug。按这个顺序查：

1. 镜像 tag 是否刚换（`kubectl get deploy <name> -o jsonpath='{.spec.template.spec.containers[*].image}'`）
2. ConfigMap / Secret 的 `metadata.creationTimestamp`
3. 最近一次 rollout 的时间和原因
4. 节点是否刚重启或驱逐过（`kubectl get nodes`、`kubectl get events -A --field-selector=reason=Evicted`）

## 输出格式（固定）

```
结论：<一句话，最多两句>
证据：
  - <命令> → <关键行，原样贴，别转述>
  - <命令> → <关键行>
不确定的地方：<没有就写"无">
下一步：
  - [可直接做的] ...
  - [需要人执行的] kubectl ... （说明影响面和回滚）
```

## 硬边界

- **不执行** `delete / exec / apply / patch / scale / drain / cordon / rollout restart`
- `port-forward` 需要人确认（它会占本地端口）
- 不猜 namespace、不猜 pod 名；拿不准就问
- 日志里出现 token、连接串、手机号时，**在引用时打码**，不要把整段日志贴进回答
