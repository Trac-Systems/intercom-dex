// Read from an attached terminal without echoing even a masked copy of the secret.
export async function hiddenInput(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('A terminal is required for hidden password input');
  output.write(prompt);
  const raw = input.isRaw;
  input.setRawMode(true); input.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const cleanup = () => { input.off('data', data); input.off('end', end); input.off('error', fail); };
      const fail = error => { cleanup(); reject(error); };
      const end = () => fail(new Error('Terminal input ended'));
      const data = chunk => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003' || char === '\u0004') return fail(new Error('Input cancelled'));
          if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
        if (value.length > 4096) fail(new Error('Input too long'));
      };
      input.on('data', data); input.once('end', end); input.once('error', fail);
    });
  } finally { input.setRawMode(raw ?? false); input.pause(); output.write('\n'); }
}
