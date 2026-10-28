#!/usr/bin/env node
/**
 * preToolUse 钩子：拦截对集群的写操作。
 *
 * 第三道只读锁。第一道是 MCP server 的 read-only 模式（工具表里没有写操作），
 * 第二道是审批不自动化；这一道防的是「绕过去」—— 模型改用 shell 跑 kubectl，
 * 或者换一个没设只读的 MCP server。
 *
 * 契约：stdin 收事件 JSON，stdout 只输出一个 JSON 对象。
 *   - 放行：{}
 *   - 拒绝：{"permissionDecision":"deny","permissionDecisionReason":"..."}
 *
 * 失败策略：解析不了就放行（输出 {}），只往 stderr 写一行。理由是
 * 「宁可漏拦，不要因为事件格式变了就把所有工具调用全部卡死」——
 * 真要强制，第一、二道锁才是主力。
 *
 * 自测：
 *   echo '{"toolName":"shell","toolArgs":{"command":"kubectl delete pod a -n dev"}}' \
 *     | node .github/hooks/guard-kubectl.cjs
 *   → 应输出 deny
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
  const haystack = `${toolName} ${args}`;

  let hit = null;
  if (KUBE_HINT.test(haystack)) hit = haystack.match(KUBECTL_MUTATING)?.[0] ?? null;
  if (!hit && HELM_HINT.test(haystack)) hit = haystack.match(HELM_MUTATING)?.[0] ?? null;
  if (!hit) return null;

  return {
    permissionDecision: 'deny',
    permissionDecisionReason:
      `集群是只读的：检测到写操作 "${hit}"。` +
      '请改为给出完整命令（含影响面与回滚方式），由人执行。' +
      '需要观察状态时用 get / describe / logs / events。',
  };
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
