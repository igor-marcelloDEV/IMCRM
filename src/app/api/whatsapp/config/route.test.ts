import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  getSubscribedApps: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse(error: unknown) {
    const typed = error as { message?: string; status?: number }
    return Response.json(
      { error: typed.message ?? 'Erro interno do servidor' },
      { status: typed.status ?? 500 },
    )
  },
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: mocks.verifyPhoneNumber,
  registerPhoneNumber: mocks.registerPhoneNumber,
  subscribeWabaToApp: mocks.subscribeWabaToApp,
  getSubscribedApps: mocks.getSubscribedApps,
}))

import {
  DELETE as deleteConfig,
  GET as getConfig,
  POST as saveConfig,
} from './route'
import { GET as verifyRegistration } from './verify-registration/route'

function denyViewer() {
  mocks.requireRole.mockRejectedValue(
    Object.assign(new Error('Esta ação requer a função admin ou superior'), {
      status: 403,
    }),
  )
}

function expectNoSecretOrMetaUse() {
  expect(mocks.decrypt).not.toHaveBeenCalled()
  expect(mocks.encrypt).not.toHaveBeenCalled()
  expect(mocks.verifyPhoneNumber).not.toHaveBeenCalled()
  expect(mocks.registerPhoneNumber).not.toHaveBeenCalled()
  expect(mocks.subscribeWabaToApp).not.toHaveBeenCalled()
  expect(mocks.getSubscribedApps).not.toHaveBeenCalled()
}

describe('/api/whatsapp/config — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    denyViewer()
  })

  it('forbids a viewer before testing saved credentials', async () => {
    const response = await getConfig()

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoSecretOrMetaUse()
  })

  it('forbids a viewer before validating or saving credentials', async () => {
    const response = await saveConfig(
      new Request('http://localhost/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number_id: 'phone-number-id',
          access_token: 'secret-token',
        }),
      }),
    )

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoSecretOrMetaUse()
  })

  it('forbids a viewer before deleting credentials', async () => {
    const response = await deleteConfig()

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoSecretOrMetaUse()
  })

  it('forbids a viewer before running registration diagnostics', async () => {
    const response = await verifyRegistration()

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoSecretOrMetaUse()
  })
})
