export async function within(label, timeout, work) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Timed out: ' + label)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
