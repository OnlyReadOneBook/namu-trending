import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, cdpClient } from '../scripts/lib.mjs';

const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'namu-lock-')), 'lock');

test('빈 자리면 락을 잡고 pid 를 적는다', () => {
  const l = tmpLock();
  assert.deepEqual(acquireLock(l, 4242), { ok: true });
  assert.equal(fs.readFileSync(path.join(l, 'pid'), 'utf8'), '4242');
});

test('산 프로세스의 락은 뺏지 않는다', () => {
  const l = tmpLock();
  fs.mkdirSync(l); fs.writeFileSync(path.join(l, 'pid'), String(process.pid));
  assert.deepEqual(acquireLock(l, 1), { ok: false, holder: process.pid });
});

test('pid 를 아직 안 적은 갓 만든 락은 뺏지 않는다', () => {
  const l = tmpLock();
  fs.mkdirSync(l);
  assert.equal(acquireLock(l, 1).ok, false);
  assert.ok(fs.existsSync(l));
});

test('pid 없는 오래된 락과 죽은 pid 락은 뺏는다', () => {
  const l = tmpLock();
  fs.mkdirSync(l);
  assert.deepEqual(acquireLock(l, 7, { now: Date.now() + 60000 }), { ok: true });
  const l2 = tmpLock();
  fs.mkdirSync(l2); fs.writeFileSync(path.join(l2, 'pid'), '999999');
  assert.deepEqual(acquireLock(l2, 8), { ok: true });
  assert.equal(fs.readFileSync(path.join(l2, 'pid'), 'utf8'), '8');
});

function fakeWs() {
  const ws = { sent: [], send(s) { ws.sent.push(JSON.parse(s)); } };
  return ws;
}

test('응답 id 로 요청을 짝짓는다', async () => {
  const ws = fakeWs(); const send = cdpClient(ws);
  const a = send('A'); const b = send('B');
  ws.onmessage({ data: JSON.stringify({ id: ws.sent[1].id, result: 'b' }) });
  ws.onmessage({ data: JSON.stringify({ method: 'Page.event' }) });
  ws.onmessage({ data: JSON.stringify({ id: ws.sent[0].id, result: 'a' }) });
  assert.equal((await a).result, 'a');
  assert.equal((await b).result, 'b');
});

test('응답이 없으면 시간 초과로 실패한다', async () => {
  const send = cdpClient(fakeWs(), { timeoutMs: 20 });
  await assert.rejects(send('Runtime.evaluate'), /cdp-timeout:Runtime.evaluate/);
});

test('소켓이 닫히면 기다리던 요청이 모두 실패한다', async () => {
  const ws = fakeWs(); const send = cdpClient(ws, { timeoutMs: 60000 });
  const p = send('Page.navigate');
  ws.onclose();
  await assert.rejects(p, /cdp-closed/);
});

test('send 가 던지면 거부된다', async () => {
  const send = cdpClient({ send() { throw new Error('not open'); } });
  await assert.rejects(send('X'), /not open/);
});
