#!/usr/bin/env node
/**
 * preToolUse 钩子：拦截对集群的写操作，以及读 Secret。
 *
 * 第四道锁（最后一道）。前三道都在 MCP server 或审批层：只读模式、资源黑名单、
 * 审批不自动化。这一道防的是「绕过去」—— 模型改用 shell 跑 kubectl，
 * 或者换一个没设只读的 MCP server。
 *
 * 为什么还要管读：只读限制的是写，没限制读。`kubectl get secret x -o yaml`
 * 完全合规但 base64 解一下就是 token 和连接串。server 端的 denied_resources
 * 只挡得住走 MCP 的那条路，挡不住终端里的这条。
 *
 * 契约：stdin 收事件 JSON，stdout 只输出一个 JSON 对象。
 *   - 放行：{}
 *   - 拒绝：{"permissionDecision":"deny","permissionDecisionReason":"..."}
 *
 * 失败策略：解析不了就放行（输出 {}），只往 stderr 写一行。理由是
 * 「宁可漏拦，不要因为事件格式变了就把所有工具调用全部卡死」——
 * 真要强制，前几道锁才是主力。
 *
 * 自测：
 *   echo '{"toolName":"shell","toolArgs":{"command":"kubectl delete pod a -n dev"}}' \
 *     | node .github/hooks/guard-kubectl.cjs
 *   → 应输出 deny（写操作）
 *
 *   echo '{"toolName":"shell","toolArgs":{"command":"kubectl get secret db -o yaml"}}' \
 *     | node .github/hooks/guard-kubectl.cjs
 *   → 应输出 deny（读 Secret）
 *
 *   echo '{"toolName":"shell","toolArgs":{"command":"kubectl get pods -n dev"}}' \
 *     | node .github/hooks/guard-kubectl.cjs
 *   → 应输出 {}
 */

'use strict';

// 写动词。用词边界匹配，避免 "settings" 命中 set、"createFile" 命中 create。
// 注意 rollout 单独处理：`rollout status` 是只读，`rollout restart` 才是写。
const KUBECTL_MUTATING =
  /\b(delete|exec|apply|patch|scale|drain|cordon|uncordon|taint|replace|edit|create|label|annotate|set)\b|\brollout\s+(restart|undo|pause|resume)\b/;

const HELM_MUTATING = /\b(install|upgrade|uninstall|rollback|delete|repo\s+add)\b/;

// 读 Secret。用「前后是空白或逗号」而不是 \b，避免把 -l secret=foo 这类标签选择器、
// 或 secret-provider-class 这类资源名一起拦掉；但要接住 kubernetes 的两种写法：
// secrets/db（斜杠形式）和 pods,secrets（逗号并列）。
const SECRET_READ = /\b(get|describe)\b[^|;&]*?(?:^|[\s,])secrets?(?=[\s/]|$)/;

// 出现这些才算「在动集群」，避免把普通的 delete 单词（比如删个本地文件）也拦掉。
const KUBE_HINT = /kubectl|kube-|k8s|kubernetes|\bkubeconfig\b/i;
const HELM_HINT = /\bhelm\b/i;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function serialize(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

function decide(event) {
  const toolName = serialize(event?.toolName);
  const args = serialize(event?.toolArgs);
  // 把下划线当分隔符：MCP 工具名是 pods_delete / resources_delete 这种写法，
  // 而 \b 在 "pods_delete" 中间不成立（下划线算单词字符）。换成空格后才能被
  // KUBECTL_MUTATING 认出来 —— 否则这道锁对「MCP 层的写操作」完全失效。
  const haystack = `${toolName} ${args}`.replace(/_/g, ' ');

  if (KUBE_HINT.test(haystack)) {
    const mutating = haystack.match(KUBECTL_MUTATING)?.[0] ?? null;
    if (mutating) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason:
          `集群是只读的：检测到写操作 "${mutating}"。` +
          '请改为给出完整命令（含影响面与回滚方式），由人执行。' +
          '需要观察状态时用 get / describe / logs / events。',
      };
    }
    if (SECRET_READ.test(haystack)) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Secret 内容不允许读取：它包含 token、证书和连接串。' +
          '排障时描述需求即可（键名、是否存在、是否挂载成功），' +
          '需要看内容请让人类执行，不要把输出贴回对话。',
      };
    }
  }

  if (HELM_HINT.test(haystack)) {
    const hit = haystack.match(HELM_MUTATING)?.[0] ?? null;
    if (hit) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason:
          `集群是只读的：检测到 helm 写操作 "${hit}"。` +
          '请给出完整命令与回滚方式，由人执行；查询用 helm list / helm status。',
      };
    }
  }

  return null;
}

(async () => {
  const raw = await readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.stderr.write('guard-kubectl: 无法解析事件 JSON，放行\n');
    process.stdout.write('{}');
    return;
  }

  const decision = decide(event);
  if (decision) {
    process.stderr.write(`guard-kubectl: 拦截 ${decision.permissionDecisionReason}\n`);
    process.stdout.write(JSON.stringify(decision));
  } else {
    process.stdout.write('{}');
  }
})();
