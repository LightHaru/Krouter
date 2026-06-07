import { newConfig, type RegistrationConfig } from '../../main/registration/config'
import { Registrar, type RegistrationResult, type RegStepEvent } from '../../main/registration/registrar'
import {
  closeProtonWindow,
  getProtonLoginStatus,
  openProtonLogin
} from './protonBrowserRuntime'

type EmitFn = (channel: string, ...args: unknown[]) => void

const registrarPool = new Map<string, Registrar>()
const MANUAL_KEY = '__manual__'

function emitLog(emit: EmitFn, message: string, taskId?: string): void {
  emit('registration-log', { message, taskId })
}

function emitStep(emit: EmitFn, event: RegStepEvent, taskId?: string): void {
  emit('registration-step', { taskId, event })
}

export async function registrationStartAuto(
  input: Partial<RegistrationConfig> & { taskId?: string },
  emit: EmitFn
): Promise<{ success: boolean; result?: RegistrationResult; error?: string }> {
  const taskId = input.taskId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const prefix = input.taskId ? `[#${input.taskId.slice(0, 12)}] ` : ''
  const cfg = newConfig(input)
  cfg.manualMode = false
  const registrar = new Registrar(
    cfg,
    (message) => emitLog(emit, `${prefix}${message}`, input.taskId),
    (event) => emitStep(emit, event, input.taskId)
  )
  registrarPool.set(taskId, registrar)
  try {
    const result = await registrar.run()
    registrarPool.delete(taskId)
    if (!input.taskId) emit('registration-complete', result)
    return { success: true, result }
  } catch (error) {
    registrarPool.delete(taskId)
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function registrationManualPhase1(
  input: Partial<RegistrationConfig>,
  emit: EmitFn
): Promise<unknown> {
  if (registrarPool.has(MANUAL_KEY)) return { success: false, error: 'A manual registration flow is already in progress' }
  const cfg = newConfig(input)
  cfg.manualMode = true
  const registrar = new Registrar(cfg, (message) => emitLog(emit, message), (event) => emitStep(emit, event))
  registrarPool.set(MANUAL_KEY, registrar)
  const result = await registrar.runManualPhase1()
  if (!(result as { success?: boolean }).success) {
    await registrar.destroy()
    registrarPool.delete(MANUAL_KEY)
  }
  return result
}

export async function registrationManualPhase2(email: string, fullName?: string): Promise<unknown> {
  const registrar = registrarPool.get(MANUAL_KEY)
  if (!registrar) return { success: false, error: 'No manual registration flow is in progress' }
  const result = await registrar.runManualPhase2(email, fullName)
  if (!(result as { success?: boolean }).success) {
    await registrar.destroy()
    registrarPool.delete(MANUAL_KEY)
  }
  return result
}

export async function registrationManualPhase3(otp: string): Promise<unknown> {
  const registrar = registrarPool.get(MANUAL_KEY)
  if (!registrar) return { success: false, error: 'No manual registration flow is in progress' }
  const result = await registrar.runManualPhase3(otp)
  await registrar.destroy()
  registrarPool.delete(MANUAL_KEY)
  return { success: true, result }
}

export async function registrationCancel(taskId?: string): Promise<{ success: true }> {
  if (taskId) {
    const registrar = registrarPool.get(taskId)
    if (registrar) {
      registrar.abort()
      await registrar.destroy()
      registrarPool.delete(taskId)
    }
    return { success: true }
  }

  const tasks = Array.from(registrarPool.entries())
  for (const [id, registrar] of tasks) {
    registrar.abort()
    await registrar.destroy()
    registrarPool.delete(id)
  }
  return { success: true }
}

export function registrationStatus(): { inProgress: boolean; count: number } {
  return { inProgress: registrarPool.size > 0, count: registrarPool.size }
}

export function protonOpenLogin(): ReturnType<typeof openProtonLogin> {
  return openProtonLogin()
}

export function protonLoginStatus(): ReturnType<typeof getProtonLoginStatus> {
  return getProtonLoginStatus()
}

export async function protonClose(): Promise<{ success: true }> {
  await closeProtonWindow()
  return { success: true }
}
