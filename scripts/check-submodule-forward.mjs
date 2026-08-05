#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUBMODULE_PATH = 'cindy-protocol';

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function readGitlink(repoRoot, ref, submodulePath = SUBMODULE_PATH) {
  const result = git(repoRoot, ['ls-tree', ref, '--', submodulePath]);
  const match = result.stdout.trim().match(/^160000 commit ([0-9a-f]{40})\t(.+)$/i);
  if (!match || match[2] !== submodulePath) {
    throw new Error(`${ref} 中缺少合法的 ${submodulePath} gitlink`);
  }
  return match[1].toLowerCase();
}

function isAncestor(repoRoot, older, newer) {
  const result = git(repoRoot, ['merge-base', '--is-ancestor', older, newer], {
    allowFailure: true,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = (result.stderr || result.stdout || '').trim();
  throw new Error(`无法比较协议历史 ${older.slice(0, 10)}..${newer.slice(0, 10)}${detail ? `: ${detail}` : ''}`);
}

export function classifyProtocolRelation(protocolRepo, baseOid, headOid, mainlineOid = null) {
  if (baseOid === headOid) return 'unchanged';
  if (isAncestor(protocolRepo, baseOid, headOid)) return 'forward';
  if (isAncestor(protocolRepo, headOid, baseOid)) return 'rollback';
  // squash 合并会打断祖先链: 分支 commit 被 squash 进协议 main 后, 新 main commit
  // 与旧分支 pin 互不为祖先。真正的不变量是「pin 必须落在协议 main 上」
  // (docs/dev-rules/protocol-and-submodules.md), 因此分叉仅在新 pin 位于协议
  // main 主线时视为合法回归; 从主线迁出、或两头都不在主线上, 仍然拦下。
  // 注意: 回归目标不要求是 main 头(允许 pin 到已合并的历史 commit), 所以
  // 从「分支 pin」退到「分支点之后、squash 之前」的旧 main commit 也会放行,
  // 这类内容回退靠 PR review 的 submodule diff 兜底。
  if (mainlineOid !== null && isAncestor(protocolRepo, headOid, mainlineOid)) {
    return 'mainline-repair';
  }
  return 'diverged';
}

function resolveProtocolMainline(protocolRepo) {
  const fetched = git(protocolRepo, ['fetch', '--no-tags', 'origin', 'main'], {
    allowFailure: true,
  });
  if (fetched.status === 0) {
    return git(protocolRepo, ['rev-parse', 'FETCH_HEAD']).stdout.trim().toLowerCase();
  }
  const local = git(protocolRepo, ['rev-parse', '--verify', 'refs/remotes/origin/main'], {
    allowFailure: true,
  });
  if (local.status === 0) return local.stdout.trim().toLowerCase();
  return null;
}

function ensureCommit(protocolRepo, oid) {
  if (git(protocolRepo, ['cat-file', '-e', `${oid}^{commit}`], { allowFailure: true }).status === 0) {
    return;
  }
  git(protocolRepo, ['fetch', '--no-tags', 'origin', oid]);
}

export function validateSubmoduleForward(repoRoot, baseRef, headRef = 'HEAD') {
  const baseOid = readGitlink(repoRoot, baseRef);
  const headOid = readGitlink(repoRoot, headRef);
  const protocolRepo = path.join(repoRoot, SUBMODULE_PATH);
  ensureCommit(protocolRepo, baseOid);
  ensureCommit(protocolRepo, headOid);
  let relation = classifyProtocolRelation(protocolRepo, baseOid, headOid);
  if (relation === 'diverged') {
    // 只有走到分叉才解析主线(多一次网络 fetch), 正常 forward 路径零额外开销。
    relation = classifyProtocolRelation(
      protocolRepo,
      baseOid,
      headOid,
      resolveProtocolMainline(protocolRepo),
    );
  }
  return { baseRef, headRef, baseOid, headOid, relation };
}

function main() {
  const repoRoot = process.cwd();
  const baseRef = process.env.CINDY_PROTOCOL_BASE_REF || 'origin/main';
  const result = validateSubmoduleForward(repoRoot, baseRef);
  const summary = `${result.baseOid.slice(0, 10)} -> ${result.headOid.slice(0, 10)}`;
  if (result.relation === 'rollback') {
    console.error(`::error file=cindy-protocol::cindy-protocol gitlink 回退: ${summary}`);
    process.exitCode = 1;
    return;
  }
  if (result.relation === 'diverged') {
    console.error(
      `::error file=cindy-protocol::cindy-protocol gitlink 与 base 分叉且新指针不在协议 main 上: ${summary}`,
    );
    process.exitCode = 1;
    return;
  }
  if (result.relation === 'mainline-repair') {
    console.log(`cindy-protocol gitlink 回归协议 main 主线: ${summary}`);
    return;
  }
  console.log(`cindy-protocol gitlink ${result.relation === 'forward' ? '前进' : '未变化'}: ${summary}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
