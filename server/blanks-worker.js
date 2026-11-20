'use strict';
// Worker thread: reads one PDF and reports its blanks. Any crash stays inside this thread.
const { parentPort, workerData } = require('node:worker_threads');
const { detectBlanks } = require('./blanks');

process.on('unhandledRejection', (e) => { parentPort.postMessage({ error: String((e && e.message) || e) }); });
detectBlanks(Buffer.from(workerData))
  .then((result) => parentPort.postMessage({ result }))
  .catch((e) => parentPort.postMessage({ error: String((e && e.message) || e) }));
