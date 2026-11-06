import { join } from 'node:path';
import { resetSourceURL } from '../../reset-source.mjs';

// Real, disposable MSB writers; RESET gateways are not MSB validators.
export async function startValidatorPool(local, admin) {
  const [{ MainSettlementBus }, { Config }, { createConfig, ENV }, { applyStateMessageFactory },
    { safeEncodeApplyOperation }, { until }] = await Promise.all([
    import(resetSourceURL('node_modules/trac-msb/src/index.js')),
    import(resetSourceURL('node_modules/trac-msb/src/config/config.js')),
    import(resetSourceURL('node_modules/trac-msb/src/config/env.js')),
    import(resetSourceURL('node_modules/trac-msb/src/messages/state/applyStateMessageFactory.js')),
    import(resetSourceURL('node_modules/trac-msb/src/utils/protobuf/operationHelpers.js')),
    import(resetSourceURL('tests/helpers/local-network.mjs'))
  ]);
  const validators = [admin];
  for (let i = 1; i <= 2; i++) {
    const name = `msb-validator-${i}`, wallet = await local.wallet(name, true);
    const config = new Config({ storeName: name, storesDirectory: join(local.root, name, 'bus'),
      bootstrap: admin.config.bootstrap, channel: 'local-foundation-msb', dhtBootstrap: local.dhtBootstrap,
      enableInteractiveMode: false, enableWallet: true, enableValidatorObserver: false,
      enableRoleRequester: false, enableTxApplyLogs: false }, createConfig(ENV.DEVELOPMENT));
    const validator = new MainSettlementBus(config, wallet);
    local.buses.push(validator); await validator.ready();
    await validator.network.tryConnect(admin.wallet.publicKey.toString('hex'), 'validator');
    await until(() => validator.state.getAdminEntry(), `${name} replicated admin`);
    await local.fund(admin, wallet);
    const allow = await applyStateMessageFactory(admin.wallet, admin.config).buildCompleteAppendWhitelistMessage(
      admin.wallet.address, wallet.address, await admin.state.getIndexerSequenceState());
    await admin.state.append(safeEncodeApplyOperation(allow));
    await until(async () => (await validator.state.getNodeEntry(wallet.address))?.isWhitelisted, `${name} whitelisted`);
    await validator.requestWriterRole(true);
    await until(async () => (await admin.state.getNodeEntry(wallet.address))?.isWriter && validator.state.isWritable(), `${name} admitted`);
    validators.push(validator);
  }
  const bus = await local.client(admin);
  const connect = async () => {
    for (const validator of validators) await bus.network.tryConnect(validator.wallet.publicKey.toString('hex'), 'validator');
  };
  await connect();
  await until(async () => (await fixtureValidatorHealth(bus)).eligible === 3, 'three eligible MSB validators');
  // The reference client drops a validator after some refusals and returns false at once when
  // none is connected; trac-peer ignores that result and never resends. Wait for a connected
  // validator and resend; a transaction that already landed is answered as already existing.
  const orchestrator = bus.network.validatorMessageOrchestrator, send = orchestrator.send.bind(orchestrator);
  orchestrator.send = async (message, retries = 0) => {
    if (retries) return send(message, retries);
    for (let attempt = 0; attempt < 5; attempt++) {
      await until(async () => (await fixtureValidatorHealth(bus)).connected > 0 || (await connect(), false), 'connected MSB validator', 30000);
      if (await send(message)) return true;
    }
    return false;
  };
  // The reference client disables discovery; restore dropped/rotated connections locally.
  let pending = Promise.resolve();
  const timer = setInterval(() => { pending = pending.then(connect).catch(() => {}); }, 1000);
  const close = local.close;
  local.close = async () => { clearInterval(timer); await pending; await close(); };
  return bus;
}

export async function fixtureValidatorHealth(bus, addressOf) {
  const publicKeyToAddress = addressOf ?? (await import(resetSourceURL('node_modules/trac-msb/src/utils/helpers.js'))).publicKeyToAddress;
  const keys = [...new Set(bus.network.validatorConnectionManager.connectedValidators())];
  const admin = await bus.state.getAdminEntry();
  let eligible = 0;
  for (const key of keys) {
    const address = publicKeyToAddress(key, bus.config), entry = await bus.state.getNodeEntry(address);
    if (entry?.isWriter || address === admin?.address) eligible++;
  }
  return { eligible, connected: keys.length, required: 3 };
}
