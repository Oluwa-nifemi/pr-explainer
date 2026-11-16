import { appendFile, appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { redact, errorDetails } from './diagnostics.js';
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
let currentWrite = Promise.resolve();
const stderr = console.error.bind(console);

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
  currentWrite = new Promise((resolve) => {
    appendFile(FILE, chunk, (err) => {
      writing = false;
      if (err) stderr('log write failed ' + errorDetails(err));
      else {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BYTES) rotate();
      }
      if (buffer && !timer) timer = setTimeout(flush, 200);
      resolve();
    });
  });
}

export async function exportLogs() {
  await currentWrite;
  if (timer) clearTimeout(timer);
  flush();
  await currentWrite;
  prune();
  let remaining = 2 * 1024 * 1024;
  const files = [];
  const errors = [];
  let truncated = false;
  for (let i = 0; i <= KEEP; i++) {
    const name = 'service.log' + (i ? '.' + i : '');
    let handle;
    try {
      handle = await open(join(DIR, name), 'r');
      const stat = await handle.stat();
      const length = Math.min(stat.size, remaining);
      if (length < stat.size) truncated = true;
      if (!length) continue;
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, stat.size - length);
      let text = bytes.subarray(0, bytesRead).toString('utf8');
      if (length < stat.size) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
      files.unshift({ name, text: redact(text) });
      remaining -= length;
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push({ name, error: errorDetails(err) });
    } finally {
      await handle?.close();
    }
  }
  if (!files.length && !errors.length) errors.push({ error: 'No service log files are available.' });
  return { files, errors, truncated, limitBytes: 2 * 1024 * 1024 };
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
