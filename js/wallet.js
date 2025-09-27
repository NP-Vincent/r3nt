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

const USER_REJECTION_NUMERIC_CODES = new Set([4001]);
const USER_REJECTION_STRING_CODES = new Set([
  '4001',
  'action_rejected',
  'user_rejected_request',
  'userrejectedrequest',
]);
const USER_REJECTION_NAMES = new Set([
  'userrejectedrequesterror',
  'userrejectedrequest',
  'provideruserrejectedrequesterror',
  'provideruserrejectedrequest',
  'actionrejectederror',
  'actionrejected',
]);
const USER_REJECTION_MESSAGE_PATTERNS = [
  /user[^a-z0-9]*rejected/i,
  /user[^a-z0-9]*denied/i,
  /user[^a-z0-9]*cancell?ed/i,
  /rejected[^a-z0-9]*by[^a-z0-9]*user/i,
  /denied[^a-z0-9]*by[^a-z0-9]*user/i,
  /action[^a-z0-9]*rejected[^a-z0-9]*by[^a-z0-9]*user/i,
];
const ERROR_NESTED_KEYS = [
  'cause',
  'error',
  'data',
  'details',
  'errors',
  'innerError',
  'originalError',
  'reason',
  'response',
  'source',
  'value',
];

function hasNonEmptyObject(obj) {
  if (obj == null || typeof obj !== 'object') {
    return false;
  }
  if (Array.isArray(obj)) {
    return obj.some((entry) => entry != null);
  }
  return Object.keys(obj).length > 0;
}

function isWalletSendCallsPromptlessRejection(error) {
  if (error == null) {
    return false;
  }

  const visited = new Set();
  const queue = [error];
  let sawRejectionCode = false;
  let sawData = false;
  let sawTxResults = false;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || typeof current !== 'object') {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const code = normalizeCode(current.code ?? current.status ?? current.errorCode);
    if (code) {
      if (USER_REJECTION_STRING_CODES.has(code)) {
        sawRejectionCode = sawRejectionCode || code === '4001';
      } else {
        const numeric = Number(code);
        if (Number.isFinite(numeric) && USER_REJECTION_NUMERIC_CODES.has(numeric)) {
          sawRejectionCode = sawRejectionCode || numeric === 4001;
        }
      }
    }

    if ('txResults' in current) {
      const txResults = current.txResults;
      if (Array.isArray(txResults)) {
        if (txResults.some((entry) => entry != null)) {
          sawTxResults = true;
        }
        for (const entry of txResults) {
          if (entry != null) queue.push(entry);
        }
      } else if (txResults && typeof txResults === 'object') {
        if (hasNonEmptyObject(txResults)) {
          sawTxResults = true;
        }
        queue.push(txResults);
      } else if (txResults != null) {
        sawTxResults = true;
      }
    }

    if ('data' in current) {
      const dataValue = current.data;
      if (Array.isArray(dataValue)) {
        if (dataValue.some((entry) => entry != null)) {
          sawData = true;
        }
        for (const entry of dataValue) {
          if (entry != null) queue.push(entry);
        }
      } else if (dataValue && typeof dataValue === 'object') {
        if (hasNonEmptyObject(dataValue)) {
          sawData = true;
        }
        queue.push(dataValue);
      } else if (dataValue != null) {
        sawData = true;
      }
    }

    for (const key of ERROR_NESTED_KEYS) {
      if (key === 'data') continue;
      if (!(key in current)) continue;
      const nested = current[key];
      if (nested == null) continue;
      if (typeof nested === 'object') {
        queue.push(nested);
      }
    }
  }

  return sawRejectionCode && !sawData && !sawTxResults;
}

function normalizeCode(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }
  return '';
}

function matchesUserRejectionMessage(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return USER_REJECTION_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isUserRejectedRequestError(error) {
  if (error == null) return false;

  const visited = new Set();
  const queue = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) {
      continue;
    }

    if (typeof current === 'string') {
      if (matchesUserRejectionMessage(current)) {
        return true;
      }
      continue;
    }

    if (typeof current !== 'object') {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const code = normalizeCode(current.code ?? current.status ?? current.errorCode);
    if (code) {
      if (USER_REJECTION_STRING_CODES.has(code)) return true;
      const numeric = Number(code);
      if (Number.isFinite(numeric) && USER_REJECTION_NUMERIC_CODES.has(numeric)) return true;
    }

    const name = typeof current.name === 'string' ? current.name.trim().toLowerCase() : '';
    if (name && USER_REJECTION_NAMES.has(name)) {
      return true;
    }

    if (matchesUserRejectionMessage(current.shortMessage)) return true;
    if (matchesUserRejectionMessage(current.message)) return true;
    if (matchesUserRejectionMessage(current.reason)) return true;
    if (matchesUserRejectionMessage(current.details)) return true;

    for (const key of ERROR_NESTED_KEYS) {
      if (!(key in current)) continue;
      const value = current[key];
      if (value == null) continue;
      if (typeof value === 'string') {
        if (matchesUserRejectionMessage(value)) {
          return true;
        }
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry != null) queue.push(entry);
        }
        continue;
      }
      if (typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return false;
}

function pushMessage(messages, value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '[object Object]') return;
  messages.push(trimmed);
}

function parseJsonBody(body, messages, visited) {
  if (typeof body !== 'string') return;
  try {
    const parsed = JSON.parse(body);
    traverseErrorForMessages(parsed, messages, visited);
  } catch {}
}

function traverseErrorForMessages(value, messages, visited) {
  if (value == null) return;

  if (typeof value === 'string') {
    pushMessage(messages, value);
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  if (visited.has(value)) {
    return;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry) => traverseErrorForMessages(entry, messages, visited));
    return;
  }

  pushMessage(messages, value.shortMessage);
  pushMessage(messages, value.message);
  pushMessage(messages, value.reason);

  if (typeof value.details === 'string') {
    pushMessage(messages, value.details);
  } else if (typeof value.details === 'object') {
    traverseErrorForMessages(value.details, messages, visited);
  }

  if (typeof value.error === 'string') {
    pushMessage(messages, value.error);
  } else if (typeof value.error === 'object') {
    traverseErrorForMessages(value.error, messages, visited);
  }

  if (typeof value.data === 'string') {
    pushMessage(messages, value.data);
  } else if (typeof value.data === 'object') {
    traverseErrorForMessages(value.data, messages, visited);
  }

  if (Array.isArray(value.errors)) {
    value.errors.forEach((item) => traverseErrorForMessages(item, messages, visited));
  }

  if (Array.isArray(value.details)) {
    value.details.forEach((item) => traverseErrorForMessages(item, messages, visited));
  }

  if (typeof value.body === 'string') {
    pushMessage(messages, value.body);
    parseJsonBody(value.body, messages, visited);
  }

  if (typeof value.error?.body === 'string') {
    pushMessage(messages, value.error.body);
    parseJsonBody(value.error.body, messages, visited);
  }

  if (typeof value.cause === 'string' || typeof value.cause === 'object') {
    traverseErrorForMessages(value.cause, messages, visited);
  }

  if (typeof value.originalError === 'object') {
    traverseErrorForMessages(value.originalError, messages, visited);
  }
}

export function extractErrorMessage(error, fallback = 'Unknown error') {
  const messages = [];
  traverseErrorForMessages(error, messages, new Set());
  const primary = messages.find(Boolean);
  if (primary) {
    return primary;
  }
  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (trimmed) return trimmed;
  }
  if (error != null) {
    try {
      const stringified = String(error);
      if (stringified && stringified !== '[object Object]') {
        return stringified;
      }
    } catch {}
  }
  return fallback;
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
      if (isWalletSendCallsPromptlessRejection(error)) {
        return { result: undefined, unsupported: true, error, reason: 'promptless-user-rejection' };
      }
      if (isUserRejectedRequestError(error)) {
        throw error;
      }
      if (isMethodNotFoundError(error)) {
        return { result: undefined, unsupported: true, error, reason: 'method-not-found' };
      }
      if (i === attempts.length - 1) {
        throw error;
      }
    }
  }
  return { result: undefined, unsupported: false };
}
