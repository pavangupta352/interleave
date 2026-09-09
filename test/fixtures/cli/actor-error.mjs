export default { name: 'cli-actor-error', async setup() {}, actors: { async alice() { throw new Error('Actor rejected'); }, async bob() {} }, async invariant() {} };
