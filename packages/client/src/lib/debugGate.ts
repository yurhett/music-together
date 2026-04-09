const PERSISTENT_DEBUG_RUNTIME_KEY = 'mt-enable-persistent-debug-logs'

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true'
}

function readRuntimeFlag(): boolean {
  try {
    return localStorage.getItem(PERSISTENT_DEBUG_RUNTIME_KEY) === '1'
  } catch {
    return false
  }
}

export function isPersistentDebugEnabled(): boolean {
  if (isTruthyFlag(import.meta.env.VITE_ENABLE_PERSISTENT_DEBUG_LOGS)) {
    return true
  }
  return readRuntimeFlag()
}

export function getPersistentDebugRuntimeKey(): string {
  return PERSISTENT_DEBUG_RUNTIME_KEY
}
