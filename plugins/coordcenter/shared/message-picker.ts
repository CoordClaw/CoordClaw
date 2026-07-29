export function pickRandom(messages: string[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  if (messages.length === 1) return messages[0];
  const index = Math.floor(Math.random() * messages.length);
  return messages[index];
}

export function isCheckEnabled(teamData: any, checkKey: string): boolean {
  const check = teamData?.[checkKey];
  if (typeof check?.enabled === 'boolean') return check.enabled;
  return true;
}

function spliceRolePrompt(teamData: any, checkKey: string, sessionKey: string, message: string): string {
  const check = teamData?.[checkKey];
  if (!check?.splice_role_prompt) return message;
  const members = teamData?.members;
  if (!Array.isArray(members)) return message;
  const member = members.find((m: any) => m.sessionKey === sessionKey);
  if (!member || !Array.isArray(member.role_prompt) || member.role_prompt.length === 0) return message;
  const rolePrompt = pickRandom(member.role_prompt);
  if (!rolePrompt) return message;
  return rolePrompt + message;
}

export function getCheckMessage(
  teamData: any,
  checkKey: string,
  fallbackKey: string,
  defaultMsg: string,
  sessionKey?: string,
): string {
  const check = teamData?.[checkKey];
  let message: string;
  if (check?.enabled && check?.message && Array.isArray(check.message) && check.message.length > 0) {
    message = pickRandom(check.message);
  } else if (typeof teamData?.[fallbackKey] === 'string' && teamData[fallbackKey].length > 0) {
    message = teamData[fallbackKey];
  } else {
    message = defaultMsg;
  }
  if (sessionKey) {
    message = spliceRolePrompt(teamData, checkKey, sessionKey, message);
  }
  return message;
}