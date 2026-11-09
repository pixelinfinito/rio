#!/usr/bin/env node
process.on('SIGTERM', () => {});
process.stdout.write(JSON.stringify({ type: 'started', pid: process.pid, directory: process.cwd() }) + '\n');
setInterval(() => {}, 1000);
