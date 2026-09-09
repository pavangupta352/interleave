process.kill(process.pid, 'SIGTERM');
await new Promise(() => undefined);
export default undefined;
