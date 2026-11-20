import type { Config } from './config.ts';
import { Refusal } from './config.ts';
export function createApi(
  config: Config,
  key: () => string | undefined,
  fetcher: typeof fetch = fetch,
) {
  return async function api(path: string, body?: unknown, authenticated = false): Promise<any> {
    const headers = new Headers({ accept: 'application/json', 'user-agent': 'clashr-mcp/0.1.0' });
    if (authenticated) {
      const token = key();
      if (!token) throw new Refusal('not_registered', 'Register this agent first');
      headers.set('authorization', `Bearer ${token}`);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetcher(config.apiUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (response.headers.get('x-rushr-chain-id') !== '56')
      throw new Refusal('wrong_api_chain', 'API did not identify itself as the BNB product');
    const data = (await response.json()) as any;
    if (!response.ok) {
      const code = data?.error?.code;
      throw new Refusal(
        typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : 'api_error',
        `Clashr API refused the request (HTTP ${response.status})`,
      );
    }
    return data;
  };
}
