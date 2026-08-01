import * as fs from "node:fs";

/**
 * 原子写入 JSON 文件（write .tmp → rename），防写中断损坏。
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * 安全版：原子写入 + 错误捕获，返回结果对象而非抛异常。
 * 优先 tmp+rename；rename 失败（Windows 锁文件）则回退直接覆盖写入。
 */
export function writeJsonSafe(filePath: string, data: unknown): { ok: boolean; error?: string } {
  const content = JSON.stringify(data, null, 2);
  try {
    // 策略1：原子写入（tmp + rename），带 EPERM/EBUSY 退避重试
    const tmpPath = filePath + ".tmp";
    try {
      writeFileWithRetry(tmpPath, content);
      fs.renameSync(tmpPath, filePath);
      return { ok: true };
    } catch {
      // Windows 上目标文件可能被占用，清理 .tmp 后回退直接覆盖写入
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      writeFileWithRetry(filePath, content);
      return { ok: true };
    }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * 致命写点封装：调用 writeJsonSafe，失败时抛错（便于上层 catch 统一处理/回滚）。
 * 用于原本 writeJsonAtomic 抛错、由上层 try/catch 捕获的写点。
 */
export function writeJsonSafeOrThrow(filePath: string, data: unknown, ctx?: string): void {
  const r = writeJsonSafe(filePath, data);
  if (!r.ok) {
    throw new Error(ctx ? `${ctx}: ${r.error}` : String(r.error));
  }
}

// ═══ EBUSY 退避（P5·v2.4） — Windows 高频并发写场景下 EBUSY 自动重试 ═══

/** 同步写文件 + EBUSY 退避（最多 retries 次，递增延迟） */
export function writeFileWithRetry(filePath: string, data: string, retries = 3): void {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(filePath, data, "utf-8");
      return;
    } catch (e: any) {
      lastErr = e;
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      if (i < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < 10 * (i + 1)) { /* spin for backoff */ }
      }
    }
  }
  throw lastErr;
}

/** 同步追加文件 + EBUSY 退避 */
export function appendFileWithRetry(filePath: string, data: string, retries = 3): void {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      fs.appendFileSync(filePath, data, "utf-8");
      return;
    } catch (e: any) {
      lastErr = e;
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      if (i < retries - 1) {
        const start = Date.now();
        while (Date.now() - start < 10 * (i + 1)) { /* spin */ }
      }
    }
  }
  throw lastErr;
}
