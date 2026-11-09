import { appendFile, appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

// Copies everything the service and the pipeline print into one rotating file.
// Import this first, before any module that logs.

const HOME_DIR = join(process.env.PRX_HOME || join(homedir(), '.cache', 'pr-explainer'), 'logs');

function usable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'service.log'), '');
    return true;
  } catch {
    return false;
  }
}

const wanted = process.env.PRX_LOG_DIR;
const DIR = wanted && usable(wanted) ? wanted : HOME_DIR;
const FILE = join(DIR, 'service.log');
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 5;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

let size = 0;
let buffer = '';
let writing = false;
let timer = null;

function prune() {
  try {
    for (const name of readdirSync(DIR)) {
      if (!/^service\.log\.\d+$/.test(name)) continue;
      const path = join(DIR, name);
      const n = Number(name.split('.').pop());
      if (n > KEEP || Date.now() - statSync(path).mtimeMs > MAX_AGE_MS) unlinkSync(path);
    }
  } catch {}
}

function rotate() {
  try {
    for (let i = KEEP; i >= 1; i--) {
      const from = i === 1 ? FILE : FILE + '.' + (i - 1);
      try {
        renameSync(from, FILE + '.' + i);
      } catch {}
    }
    size = 0;
    prune();
  } catch {}
}

function flush() {
  timer = null;
  if (writing || !buffer) return;
  const chunk = buffer;
  buffer = '';
  writing = true;
  appendFile(FILE, chunk, () => {
    writing = false;
    size += Buffer.byteLength(chunk);
    if (size > MAX_BYTES) rotate();
    if (buffer) flush();
  });
}

function write(kind, args) {
  buffer += new Date().toISOString() + ' ' + kind + ' ' + format(...args) + '\n';
  if (!timer) timer = setTimeout(flush, 200);
}

try {
  mkdirSync(DIR, { recursive: true });
  try {
    size = statSync(FILE).size;
  } catch {}
  prune();
  if (size > MAX_BYTES) rotate();
  for (const [method, kind] of [['log', 'out'], ['info', 'out'], ['warn', 'err'], ['error', 'err']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(kind, args);
    };
  }
  process.on('exit', () => {
    if (buffer) {
      try {
        appendFileSync(FILE, buffer);
      } catch {}
    }
  });
  console.log('logging to ' + FILE + ' (rotates at 5 MB, keeps ' + KEEP + ' files, drops files older than 14 days)');
} catch (err) {
  console.error('could not open the log file ' + FILE + ': ' + err.message);
}
