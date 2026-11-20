import { parseAbi, toEventSelector } from 'viem';

// Deployment references: https://developer.pancakeswap.finance/contracts/v2/addresses
// and https://developer.pancakeswap.finance/contracts/v3/addresses. Mainnet only.
export const BSC_PANCAKE = Object.freeze({
  chainId: 56 as const,
  wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as const,
  v2Factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73' as const,
  v3Factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865' as const,
});
export const PANCAKE_V2 = parseAbi([
  'event PairCreated(address indexed token0,address indexed token1,address pair,uint256 count)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
  'function getPair(address token0,address token1) view returns (address)',
]);
export const PANCAKE_V3 = parseAbi([
  'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)',
  'function getPool(address token0,address token1,uint24 fee) view returns (address)',
]);
export const PANCAKE_TOPICS = Object.freeze({
  pair: toEventSelector(PANCAKE_V2[0]), pool: toEventSelector(PANCAKE_V3[0]),
  v2Swap: toEventSelector(PANCAKE_V2[1]), v3Swap: toEventSelector(PANCAKE_V3[1]),
});
