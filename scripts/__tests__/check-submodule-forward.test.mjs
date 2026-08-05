import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { classifyProtocolRelation } from '../check-submodule-forward.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-protocol-forward-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Protocol Guard Test');
  git(repo, 'config', 'user.email', 'protocol-guard@example.invalid');
  fs.writeFileSync(path.join(repo, 'protocol.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'one');
  const one = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'protocol.txt'), 'two\n');
  git(repo, 'commit', '-am', 'two');
  const two = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-b', 'fork', one);
  fs.writeFileSync(path.join(repo, 'fork.txt'), 'fork\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fork');
  const fork = git(repo, 'rev-parse', 'HEAD');
  // 模拟 squash: fork 的内容以全新 commit 落到 main 上, 与 fork 互不为祖先。
  git(repo, 'checkout', 'main');
  fs.writeFileSync(path.join(repo, 'fork.txt'), 'fork\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'squash of fork');
  const squash = git(repo, 'rev-parse', 'HEAD');
  return { repo, one, two, fork, squash };
}

test('classifies unchanged, forward, rollback and diverged protocol gitlinks', () => {
  const f = fixture();
  try {
    assert.equal(classifyProtocolRelation(f.repo, f.one, f.one), 'unchanged');
    assert.equal(classifyProtocolRelation(f.repo, f.one, f.two), 'forward');
    assert.equal(classifyProtocolRelation(f.repo, f.two, f.one), 'rollback');
    assert.equal(classifyProtocolRelation(f.repo, f.two, f.fork), 'diverged');
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});

test('mainline repair: squash 后从分支 pin 回归 main 主线才放行', () => {
  const f = fixture();
  try {
    // 分支 pin -> squash 产物(在 main 上): 合法回归。
    assert.equal(classifyProtocolRelation(f.repo, f.fork, f.squash, f.squash), 'mainline-repair');
    // 回归目标允许是 main 头之前的历史 commit(squash 本身就在头之前的场景)。
    assert.equal(classifyProtocolRelation(f.repo, f.fork, f.two, f.squash), 'mainline-repair');
    // 不给主线信息时保持原判: 分叉拦下。
    assert.equal(classifyProtocolRelation(f.repo, f.fork, f.squash), 'diverged');
    // 新指针不在 main 上: 仍是分叉, 拦下。
    assert.equal(classifyProtocolRelation(f.repo, f.two, f.fork, f.squash), 'diverged');
    // rollback 优先于回归判定: 退回分支点之前的祖先 commit 仍拦下。
    assert.equal(classifyProtocolRelation(f.repo, f.fork, f.one, f.squash), 'rollback');
  } finally {
    fs.rmSync(f.repo, { recursive: true, force: true });
  }
});
