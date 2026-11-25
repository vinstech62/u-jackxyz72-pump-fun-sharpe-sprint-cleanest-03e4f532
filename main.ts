// Whale rider: a paper-trading bot for the pump.fun Sharpe Sprint.
// One strategy program, main.ts on Node 22: it reads each batch of replay events
// the harness sends on stdin and answers with the orders for that slot on stdout.
// See strategy.ts for the idea and STRATEGY.md for the dev-window numbers.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
