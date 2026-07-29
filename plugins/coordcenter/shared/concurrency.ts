import { debug, getEventId } from "./logger";

let teamDbReadQueue: Promise<any> = Promise.resolve();

export async function withTeamDbLock<T>(operation: () => Promise<T>): Promise<T> {
  const waitStartTime = Date.now();
  const currentQueue = teamDbReadQueue;
  debug('concurrency', `withTeamDbLock: entering queue`, getEventId());
  
  const nextOperation = currentQueue.then(async () => {
    const actualWaitTime = Date.now() - waitStartTime;
    if (actualWaitTime > 500) {
      debug('concurrency', `withTeamDbLock: waited ${actualWaitTime}ms in queue`, getEventId());
    }
    
    const execStartTime = Date.now();
    const result = await operation();
    const execTime = Date.now() - execStartTime;
    
    debug('concurrency', `withTeamDbLock: operation completed in ${execTime}ms (total=${Date.now()-waitStartTime}ms)`, getEventId());
    return result;
  });
  
  teamDbReadQueue = nextOperation;
  return nextOperation;
}