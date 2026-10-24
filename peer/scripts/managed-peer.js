import process from 'process';

// Parent pipe closure also shuts down the peer if its Node runner crashes.
const stop = () => {
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
};
Bare.IPC.on('data', stop);
Bare.IPC.on('end', stop);
Bare.IPC.on('close', stop);
await import('../index.js');
