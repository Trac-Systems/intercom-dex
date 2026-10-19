import SidechannelProtocol from '../features/sidechannel/commands.js';

// The dex peer keeps no contract state: its subnet only gives the peer an identity and a swarm.
export default class DexProtocol extends SidechannelProtocol {
  mapTxCommand() { return null; }
}
