import { PublicKey } from '@solana/web3.js';

export const PROGRAM_ID = new PublicKey('4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDC_DECIMALS = 6;
export const PLATFORM_CONFIG = new PublicKey('GYEkMpHz9MEFiGjhLJTB3WC4itkVVk1ySn3jvSDhA2ig');
export const DEFAULT_ENDPOINTS = Object.freeze([
  'https://api.mainnet-beta.solana.com',
  'https://public.rpc.solanavibestation.com',
  'https://solana.api.pocket.network',
  'https://solana.leorpc.com/?api_key=FREE',
  'https://rpc.solanatracker.io/public',
  'https://solana-rpc.publicnode.com',
]);
export const DEFAULT_SLOT_TOLERANCE = 32;
export const PROGRAM_ERRORS = Object.freeze({
  1: 'InvalidInstruction', 2: 'InvalidEscrowPda', 3: 'InvalidVaultAta',
  4: 'InvalidTokenAccount', 5: 'InvalidSigner', 6: 'InvalidPreimage',
  7: 'NotActive', 8: 'TooEarly', 9: 'InvalidConfigPda', 10: 'InvalidConfigState',
  11: 'FeeTooHigh', 12: 'AlreadyInitialized', 13: 'InvalidFeeVaultAta',
  14: 'InvalidTradeConfigPda', 15: 'InvalidTradeConfigState',
  16: 'InvalidTradeFeeVaultAta', 17: 'FeeMismatch',
});
