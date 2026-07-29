import { AgentDispatchContext } from "./types";
import { getCoordClawRoot } from "./paths";

type PlaceholderResolver = (ctx: AgentDispatchContext) => string;

const registry = new Map<string, PlaceholderResolver>();

export function registerPlaceholder(key: string, resolver: PlaceholderResolver): void {
  registry.set(key, resolver);
}

export function renderTemplate(template: string, ctx: AgentDispatchContext): string {
  let result = template;
  for (const [key, resolver] of registry) {
    const placeholder = `<#${key}#>`;
    if (result.includes(placeholder)) {
      result = result.split(placeholder).join(resolver(ctx));
    }
  }
  return result;
}

export function initDefaultPlaceholders(): void {
  registerPlaceholder('name', (ctx) => ctx.agentName);
  registerPlaceholder('projectroot', (ctx) => (ctx.projectRoot || '').replace(/\\/g, '/'));
  registerPlaceholder('agentid', (ctx) => ctx.agentId);
  registerPlaceholder('sessionkey', (ctx) => ctx.sessionKey || '');
  registerPlaceholder('pmname', (ctx) => ctx.members?.[0]?.name || 'PM');
  registerPlaceholder('coordclawroot', () => (getCoordClawRoot() || '').replace(/\\/g, '/'));
}
