const DEFAULT_WALLET_SEND_CALLS_VERSION = '2.0.0';

function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeCallValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^-?0x[0-9a-fA-F]+$/i.test(trimmed)) return trimmed;
    try {
      const numeric = BigInt(trimmed);
      if (numeric === 0n) return '0x0';
      if (numeric < 0) return `-0x${(-numeric).toString(16)}`;
      return `0x${numeric.toString(16)}`;
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'bigint') {
    if (value === 0n) return '0x0';
    if (value < 0n) return `-0x${(-value).toString(16)}`;
    return `0x${value.toString(16)}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined;
    if (value === 0) return '0x0';
    if (value < 0) return `-0x${Math.abs(value).toString(16)}`;
    return `0x${value.toString(16)}`;
  }
  return undefined;
}

function normalizeCall(call) {
  if (!call || typeof call !== 'object') return null;
  const normalized = {};
  if (typeof call.to === 'string' && call.to) {
    normalized.to = call.to;
  }
  if (typeof call.data === 'string' && call.data) {
    normalized.data = call.data;
  }
  if ('value' in call) {
    const value = normalizeCallValue(call.value);
    if (value !== undefined) normalized.value = value;
  }
  if ('gas' in call) {
    const gas = normalizeCallValue(call.gas);
    if (gas !== undefined) normalized.gas = gas;
  }
  if ('gasLimit' in call && normalized.gas === undefined) {
    const gasLimit = normalizeCallValue(call.gasLimit);
    if (gasLimit !== undefined) normalized.gas = gasLimit;
  }
  if ('maxFeePerGas' in call) {
    const maxFeePerGas = normalizeCallValue(call.maxFeePerGas);
    if (maxFeePerGas !== undefined) normalized.maxFeePerGas = maxFeePerGas;
  }
  if ('maxPriorityFeePerGas' in call) {
    const maxPriorityFeePerGas = normalizeCallValue(call.maxPriorityFeePerGas);
    if (maxPriorityFeePerGas !== undefined) {
      normalized.maxPriorityFeePerGas = maxPriorityFeePerGas;
    }
  }
  if (Object.keys(normalized).length === 0) {
    return null;
  }
  return normalized;
}

function expandChainIds(chainId) {
  if (chainId === undefined || chainId === null) return [];

  const candidates = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  };

  if (typeof chainId === 'string') {
    const trimmed = chainId.trim();
    if (!trimmed) return [];
    push(trimmed);
    if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
      try {
        const decimal = BigInt(trimmed).toString();
        push(`eip155:${decimal}`);
      } catch {}
    } else if (/^eip155:/i.test(trimmed)) {
      const decimalPart = trimmed.slice(7);
      if (/^\d+$/.test(decimalPart)) {
        try {
          const hex = `0x${BigInt(decimalPart).toString(16)}`;
          push(hex);
        } catch {}
      }
    } else if (/^\d+$/.test(trimmed)) {
      try {
        const decimal = BigInt(trimmed);
        push(`0x${decimal.toString(16)}`);
        push(`eip155:${decimal.toString()}`);
      } catch {}
    }
  } else if (typeof chainId === 'number' && Number.isFinite(chainId)) {
    const numeric = BigInt(Math.trunc(chainId));
    push(`0x${numeric.toString(16)}`);
    push(`eip155:${numeric.toString()}`);
  } else if (typeof chainId === 'bigint') {
    push(`0x${chainId.toString(16)}`);
    push(`eip155:${chainId.toString()}`);
  }

  return dedupe(candidates);
}

export function buildWalletSendCallsParamAttempts(options = {}) {
  const { calls, from, chainId, atomic = false, version = DEFAULT_WALLET_SEND_CALLS_VERSION, capabilities } = options;
  const normalizedCalls = Array.isArray(calls)
    ? calls.map((call) => normalizeCall(call)).filter((call) => call !== null)
    : [];

  if (normalizedCalls.length === 0) {
    return [];
  }

  const base = {
    atomicRequired: Boolean(atomic),
    calls: normalizedCalls,
  };

  if (typeof version === 'string' && version) {
    base.version = version;
  }
  if (typeof from === 'string' && from) {
    base.from = from;
  }
  if (capabilities && typeof capabilities === 'object') {
    base.capabilities = capabilities;
  }

  const attempts = [];
  const chainIds = expandChainIds(chainId);
  for (const id of chainIds) {
    attempts.push([{ ...base, chainId: id }]);
  }
  attempts.push([{ ...base }]);
  attempts.push([{ calls: normalizedCalls }]);
  attempts.push(normalizedCalls);
  return attempts;
}

export function isUserRejectedRequestError(error) {
  if (!error) return false;
  const code = Number(error.code);
  if (Number.isFinite(code) && code === 4001) return true;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (!message) return false;
  return (
    message.includes('user rejected') ||
    message.includes('user denied') ||
    message.includes('request rejected') ||
    message.includes('denied transaction') ||
    message.includes('transaction rejected')
  );
}

export function isMethodNotFoundError(error) {
  if (!error) return false;
  const code = Number(error.code);
  if (Number.isFinite(code) && code === -32601) return true;
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (!message || !message.includes('wallet_sendcalls')) return false;
  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('not supported') ||
    message.includes('unsupported')
  );
}

export async function requestWalletSendCalls(provider, options = {}) {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('Ethereum provider with request(...) is required.');
  }
  const attempts = buildWalletSendCallsParamAttempts(options);
  if (attempts.length === 0) {
    throw new Error('No calls provided for wallet_sendCalls.');
  }
  for (let i = 0; i < attempts.length; i++) {
    const params = attempts[i];
    try {
      const result = await provider.request({ method: 'wallet_sendCalls', params });
      return { result, unsupported: false };
    } catch (error) {
      if (isUserRejectedRequestError(error)) {
        throw error;
      }
      if (isMethodNotFoundError(error)) {
        return { result: undefined, unsupported: true, error };
      }
      if (i === attempts.length - 1) {
        throw error;
      }
    }
  }
  return { result: undefined, unsupported: false };
}
