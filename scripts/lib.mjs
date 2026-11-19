// namu_ranking_snapshot.mjs 에서 떼어 낸, 시험할 수 있는 조각들.
import fs from 'node:fs';
import path from 'node:path';

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 락 디렉터리를 잡는다. 성공하면 { ok: true }, 남이 잡고 있으면 { ok: false, holder }.
// mkdir 과 pid 기록 사이에는 pid 파일이 없는 순간이 있다. 그 순간에 들어온 쪽이 락을
// 죽은 것으로 보고 뺏으면 둘이 함께 돈다. 그래서 pid 가 없는 락은 graceMs 동안은 산 것으로 본다.
export function acquireLock(lock, pid = process.pid, { graceMs = 30000, now = Date.now() } = {}) {
  const take = () => { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(pid)); return { ok: true }; };
  try { return take(); } catch (e) { if (e.code !== 'EEXIST') return { ok: false, holder: 0 }; }
  let holder = 0;
  try { holder = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()) || 0; } catch {}
  if (holder && alive(holder)) return { ok: false, holder };
  if (!holder) {
    let age = Infinity;
    try { age = now - fs.statSync(lock).mtimeMs; } catch {}
    if (age < graceMs) return { ok: false, holder: 0 };
  }
  try { fs.rmSync(lock, { recursive: true, force: true }); return take(); } catch { return { ok: false, holder }; }
}

// CDP 요청-응답 짝짓기. 응답이 안 오거나 소켓이 닫히면 기다리던 요청을 모두 실패시킨다.
// 이게 없으면 Chrome 이 죽거나 응답을 빠뜨렸을 때 await 가 영원히 안 끝나고, 락을 쥔 채
// 멈춘 프로세스 때문에 이후 예약 실행이 전부 skip reason=locked 로 빠진다.
export function cdpClient(ws, { timeoutMs = 15000 } = {}) {
  let id = 0; const pend = new Map();
  const failAll = err => { for (const [, p] of pend) { clearTimeout(p.t); p.no(err); } pend.clear(); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const p = m.id && pend.get(m.id);
    if (p) { clearTimeout(p.t); pend.delete(m.id); p.ok(m); }
  };
  ws.onclose = () => failAll(new Error('cdp-closed'));
  ws.onerror = () => failAll(new Error('cdp-error'));
  return (method, params = {}) => new Promise((ok, no) => {
    const i = ++id;
    const t = setTimeout(() => { pend.delete(i); no(new Error(`cdp-timeout:${method}`)); }, timeoutMs);
    pend.set(i, { ok, no, t });
    try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(t); pend.delete(i); no(e); }
  });
}
