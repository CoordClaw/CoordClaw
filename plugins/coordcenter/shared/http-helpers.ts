import { getEventId, info, error, debug } from "./logger";

export function sendJson(res: any, statusCode: number, data: any) {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(body);
}

export interface RouteDefinition {
  method: string;
  path: string;
  auth: string;
  handler: (req: any, res: any) => Promise<void>;
}

export function registerPluginRoute(
  api: any,
  routeDef: RouteDefinition,
  moduleName: string,
): boolean {
  const eventId = getEventId();
  const { method, path } = routeDef;

  info(moduleName, `[HTTP] ${method} ${path} registerPluginRoute ENTER`, eventId);

  try {
    debug(moduleName, `[HTTP-DEBUG] STEP-1 api type=${typeof api}`, eventId);
    debug(moduleName, `[HTTP-DEBUG] STEP-2 api keys=[${Object.keys(api).join(",")}]`, eventId);
    debug(moduleName, `[HTTP-DEBUG] STEP-3 api.runtime type=${typeof api.runtime}`, eventId);
    debug(moduleName, `[HTTP-DEBUG] STEP-4 api.runtime keys=[${Object.keys(api.runtime || {}).join(",")}]`, eventId);
    debug(moduleName, `[HTTP-DEBUG] STEP-5 api.registerHttpRoute type=${typeof api.registerHttpRoute}`, eventId);
    
    if (typeof api.registerHttpRoute === "function") {
      debug(moduleName, `[HTTP-DEBUG] STEP-6 calling registerHttpRoute...`, eventId);
      api.registerHttpRoute(routeDef);
      debug(moduleName, `[HTTP-DEBUG] STEP-7 registerHttpRoute returned`, eventId);
      info(moduleName, `[HTTP] 使用 registerHttpRoute 注册成功`, eventId);
    } else if (typeof api.registerRoute === "function") {
      debug(moduleName, `[HTTP-DEBUG] STEP-6 calling registerRoute...`, eventId);
      api.registerRoute(routeDef);
      debug(moduleName, `[HTTP-DEBUG] STEP-7 registerRoute returned`, eventId);
      info(moduleName, `[HTTP] 使用 registerRoute 注册成功`, eventId);
    } else if (typeof api.http?.register === "function") {
      debug(moduleName, `[HTTP-DEBUG] STEP-6 calling http.register...`, eventId);
      api.http.register(routeDef);
      debug(moduleName, `[HTTP-DEBUG] STEP-7 http.register returned`, eventId);
      info(moduleName, `[HTTP] 使用 http.register 注册成功`, eventId);
    } else {
      error(moduleName, `[HTTP] STEP-6 FAIL 路由注册失败: 未找到支持的注册方法`, eventId);
      debug(moduleName, `[HTTP-DEBUG] api.registerHttpRoute=${typeof api.registerHttpRoute}, api.registerRoute=${typeof api.registerRoute}, api.http?.register=${typeof api.http?.register}`, eventId);
      return false;
    }

    info(moduleName, `[HTTP] 路由注册成功: ${method} ${path} (auth=plugin, 无需Token)`, eventId);
    return true;
  } catch (err: any) {
    error(moduleName, `[HTTP] 路由注册异常: ${err.message}`, eventId);
    debug(moduleName, `[HTTP-DEBUG] exception stack: ${err.stack || err.message}`, eventId);
    return false;
  }
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB
const READ_TIMEOUT_MS = 10_000;          // 10秒

export function readRawBody(req: any, maxSize: number = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearDataListener();
      req.destroy();
      reject(new Error('BODY_READ_TIMEOUT'));
    }, READ_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearDataListener();
        req.destroy();
        reject(new Error(`BODY_SIZE_EXCEEDED: ${totalSize} > ${maxSize}`));
        return;
      }
      chunks.push(chunk);
    };

    const clearDataListener = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export interface ParsedRequestBody {
  body: any;
  rawBody: string;
  debugInfo: string;
}

export async function parseRequestBody(req: any): Promise<ParsedRequestBody> {
  const eventId = getEventId();
  
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return { 
      body: {}, 
      rawBody: "",
      debugInfo: `[BODY-PARSE] ❌ 读取请求流失败: ${e}` 
    };
  }

  const hasContent = rawBody && rawBody.trim().length > 0;
  let debugInfo = `[BODY-PARSE] raw.length=${rawBody?.length || 0}, content="${rawBody?.slice(0, 150) || '(empty)'}"`;
  
  if (!hasContent) {
    return { body: {}, rawBody, debugInfo: `${debugInfo} → 空请求体` };
  }

  try {
    const parsed = JSON.parse(rawBody);
    return { 
      body: parsed, 
      rawBody,
      debugInfo: `${debugInfo} → JSON解析成功, keys=[${Object.keys(parsed).join(',')}]` 
    };
  } catch (e) {
    return { 
      body: {}, 
      rawBody,
      debugInfo: `${debugInfo} → JSON解析失败: ${e}` 
    };
  }
}