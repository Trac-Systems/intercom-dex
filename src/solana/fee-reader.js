import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import { readAccountQuorum } from './quorum.js';
import { readRpcQuorum } from './read-quorum.js';
import { deriveConfigPda, deriveTradeConfigPda, deriveVaultAta, decodeConfigState, decodeTradeConfigState } from './escrow.js';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

// Every economic audit uses finalized, agreeing public RPC reads. No signer or journal is opened here.
export function createFeeReader({ endpoints, need = 2, timeoutMs = 3000, programId, mint }) {
  const program = new PublicKey(programId), defaultMint = new PublicKey(mint);
  const options = { endpoints, need, timeoutMs, commitment: 'finalized', unanimous: true };
  const account = async (address, { minContextSlot } = {}) => (await readAccountQuorum(address, { ...options, minContextSlot })).value;
  const balance = async (owner, tokenMint = defaultMint, fence = {}) => {
    const address = deriveVaultAta(owner, tokenMint), info = await account(address, fence);
    if (!info) return '0';
    if (info.owner !== TOKEN_PROGRAM_ID.toBase58() || info.executable || info.data.length !== 165) throw new Error('Invalid token vault');
    const value = unpackAccount(address, { ...info, owner: TOKEN_PROGRAM_ID });
    if (!value.owner.equals(new PublicKey(owner)) || !value.mint.equals(new PublicKey(tokenMint)) || !value.isInitialized || value.isFrozen) throw new Error('Token vault owner, mint or state mismatch');
    return value.amount.toString();
  };
  const config = async collector => {
    const derived = collector ? deriveTradeConfigPda(collector, program) : deriveConfigPda(program);
    const info = await account(derived.pda);
    if (!info) throw new Error('Finalized fee config is missing');
    if (info.owner !== program.toBase58() || info.executable) throw new Error('Invalid fee config owner');
    const state = (collector ? decodeTradeConfigState : decodeConfigState)(info.data);
    if (state.bump !== derived.bump) throw new Error('Invalid fee config bump');
    return { authority: state.authority.toBase58(), collector: state.feeCollector.toBase58(), feeBps: state.feeBps };
  };
  return {
    async main(address) {
      const [info, rent] = await Promise.all([account(address), readRpcQuorum('getMinimumBalanceForRentExemption', [68, { commitment: 'finalized' }], options)]);
      if (![info?.lamports ?? 0, rent.value].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid SOL balance or rent');
      return { balance: String(info?.lamports ?? 0), rent: String(rent.value) };
    },
    async collector(address) {
      const state = await config(address);
      if (state.collector !== address || state.authority !== address) throw new Error('Trade config names a different key');
      return { ...state, balance: await balance(deriveTradeConfigPda(address, program).pda) };
    },
    platform: () => config(null),
    balance,
    platformBalance: (tokenMint = defaultMint, fence = {}) => balance(deriveConfigPda(program).pda, tokenMint, fence),
    async decimals(tokenMint = defaultMint) {
      const address = new PublicKey(tokenMint), info = await account(address);
      if (!info || info.owner !== TOKEN_PROGRAM_ID.toBase58() || info.executable) throw new Error('SPL mint is missing or invalid');
      const value = unpackMint(address, { ...info, owner: TOKEN_PROGRAM_ID });
      if (!value.isInitialized) throw new Error('SPL mint is not initialized');
      return value.decimals;
    },
    async upgradeAuthority() {
      const info = await account(program);
      if (!info || info.owner !== LOADER.toBase58() || !info.executable || info.data.length !== 36 || info.data.readUInt32LE(0) !== 2) throw new Error('Escrow is not an upgradeable loader program');
      const address = new PublicKey(info.data.subarray(4, 36));
      const expected = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];
      if (!address.equals(expected)) throw new Error('Programdata address does not match program');
      const data = await account(address);
      if (!data || data.owner !== LOADER.toBase58() || data.executable || data.data.length < 45 || data.data.readUInt32LE(0) !== 3) throw new Error('Invalid programdata account');
      if (data.data[12] === 0) throw new Error('Program is immutable; no upgrade authority');
      if (data.data[12] !== 1) throw new Error('Invalid programdata authority');
      return new PublicKey(data.data.subarray(13, 45)).toBase58();
    },
  };
}
