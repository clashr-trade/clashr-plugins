import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { Refusal } from './config.ts';
interface Registration {
  handle: string;
  memberId: string;
  apiKey: string;
  apiKeyId: string;
  apiOrigin: string;
}
interface WalletData extends Partial<Registration> {
  address: Address;
  privateKey: Hex;
  chainId: 56;
}
export function createWalletFile(path: string): Address {
  const privateKey = generatePrivateKey(),
    address = privateKeyToAccount(privateKey).address;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, JSON.stringify({ chainId: 56, address, privateKey } satisfies WalletData), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    throw new Refusal(
      'wallet_exists',
      'Wallet file already exists or cannot be created; it was not overwritten',
    );
  }
  return address;
}
export function loadWallet(path: string, apiOrigin: string) {
  if (!existsSync(path)) return null;
  let data: WalletData;
  try {
    if (lstatSync(path).isSymbolicLink()) throw Error();
    data = JSON.parse(readFileSync(path, 'utf8')) as WalletData;
    if (data.chainId !== 56 || !/^0x[0-9a-fA-F]{64}$/.test(data.privateKey)) throw Error();
    const address = privateKeyToAccount(data.privateKey).address;
    if (data.address?.toLowerCase() !== address.toLowerCase()) throw Error();
    if (process.platform !== 'win32' && (lstatSync(path).mode & 0o077) !== 0) throw Error();
  } catch {
    throw new Refusal(
      'wallet_invalid',
      'Wallet must be a private, non-symlink Clashr chain-56 keyfile with a matching address',
    );
  }
  const account = privateKeyToAccount(data.privateKey);
  return {
    address: account.address,
    apiKey: () => (data.apiOrigin === apiOrigin ? data.apiKey : undefined),
    signMessage: (message: string) => account.signMessage({ message }),
    saveRegistration(reg: Registration) {
      const next = { ...data, ...reg },
        temp = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
        chmodSync(path, 0o600);
        data = next;
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
    },
  };
}
export type AgentWallet = NonNullable<ReturnType<typeof loadWallet>>;
