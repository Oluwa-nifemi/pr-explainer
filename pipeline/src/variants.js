import { defineArch } from './pipeline.js';

const fan = (planner, worker, side, context, extra = {}) => ({ mode: 'fanout', planner, worker, side, context, ...extra });

defineArch('A-single-none', { mode: 'single', thinking: 'none' });
defineArch('A-single-none-ctx', { mode: 'single', thinking: 'none', context: 'prefetch' });

defineArch('B-stream', fan('default', 'default', 'default', 'none', { streamDispatch: true }));

defineArch('D-all-none', fan('none', 'none', 'none', 'prefetch'));
defineArch('D-plan-low', fan('low', 'none', 'none', 'prefetch'));
defineArch('D-plan-max', fan('default', 'none', 'none', 'prefetch'));
defineArch('D-work-max', fan('none', 'default', 'none', 'prefetch'));
defineArch('D-work-low', fan('none', 'low', 'none', 'prefetch'));

defineArch('B-none', fan('none', 'none', 'none', 'none'));
defineArch('C2-none', fan('none', 'none', 'none', 'tools'));
defineArch('E-stream-none', fan('none', 'none', 'none', 'prefetch', { streamDispatch: true }));
defineArch('R-recommended', fan('none', 'none', 'none', 'prefetch', { streamDispatch: true }));

const v2 = { streamDispatch: true, workerMaxTokens: 32000, workerTimeoutMs: 360000 };
for (const level of ['none', 'low', 'medium', 'high']) defineArch('V2-w-' + level, fan('none', level, 'none', 'v2', v2));
defineArch('V2-w-max', fan('none', 'default', 'none', 'v2', v2));
