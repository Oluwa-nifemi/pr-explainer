import { config } from './config.js';

const mod = config.fake
  ? await import('./fake.js')
  : await import('../../pipeline/src/generate.js');

export const pipelineVersion = mod.pipelineVersion;
export const generateStory = mod.generateStory;
