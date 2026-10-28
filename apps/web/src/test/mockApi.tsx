import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';

// Tests mock the network, not the client: every page goes through the real
// api/client.ts. Routes are "METHOD /path/:param"; a handler returns a body
// (status 200) or reply(status, body).

export interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
}

const REPLY = Symbol('reply');
interface Reply {
  [REPLY]: true;
  status: number;
  body: unknown;
}
export const reply = (status: number, body?: unknown): Reply => ({ [REPLY]: true, status, body });
export const apiError = (status: number, code: string, message: string, details?: Array<{ field: string; message: string }>) =>
  reply(status, { success: false, error: { code, message, details, timestamp: new Date().toISOString() } });

export type Routes = Record<string, unknown | ((call: ApiCall, params: Record<string, string>) => unknown)>;

export function mockApi(routes: Routes): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const call: ApiCall = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const [key, handler] of Object.entries(routes)) {
      const [method, pattern] = key.split(' ');
      if (method !== call.method) continue;
      const names: string[] = [];
      const regex = new RegExp(`^${pattern!.replace(/:([A-Za-z]+)/g, (_, name) => (names.push(name), '([^/]+)'))}$`);
      const match = regex.exec(call.path);
      if (!match) continue;
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
      const out = typeof handler === 'function' ? await (handler as (c: ApiCall, p: Record<string, string>) => unknown)(call, params) : handler;
      const { status, body } = out && typeof out === 'object' && REPLY in out ? (out as Reply) : { status: 200, body: out };
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` } }), { status: 404 });
  });
  return calls;
}

export function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}
