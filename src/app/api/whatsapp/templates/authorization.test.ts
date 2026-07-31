import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  decrypt: vi.fn(),
  submitMessageTemplate: vi.fn(),
  editMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
  ensureImageHeaderHandle: vi.fn(),
  fetch: vi.fn(),
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
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: mocks.submitMessageTemplate,
  editMessageTemplate: mocks.editMessageTemplate,
  deleteMessageTemplate: mocks.deleteMessageTemplate,
}))

vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureImageHeaderHandle: mocks.ensureImageHeaderHandle,
}))

import { PATCH, DELETE } from './[id]/route'
import { POST as submitTemplate } from './submit/route'
import { POST as syncTemplates } from './sync/route'

const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111'

function denyViewer() {
  mocks.requireRole.mockRejectedValue(
    Object.assign(new Error('Esta ação requer a função admin ou superior'), {
      status: 403,
    }),
  )
}

function expectNoProviderUse() {
  expect(mocks.decrypt).not.toHaveBeenCalled()
  expect(mocks.submitMessageTemplate).not.toHaveBeenCalled()
  expect(mocks.editMessageTemplate).not.toHaveBeenCalled()
  expect(mocks.deleteMessageTemplate).not.toHaveBeenCalled()
  expect(mocks.ensureImageHeaderHandle).not.toHaveBeenCalled()
  expect(mocks.fetch).not.toHaveBeenCalled()
}

describe('/api/whatsapp/templates — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    denyViewer()
    vi.stubGlobal('fetch', mocks.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forbids a viewer before submitting a template', async () => {
    const response = await submitTemplate(
      new Request('http://localhost/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoProviderUse()
  })

  it('forbids a viewer before editing a template', async () => {
    const response = await PATCH(
      new Request(`http://localhost/api/whatsapp/templates/${TEMPLATE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: TEMPLATE_ID }) },
    )

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoProviderUse()
  })

  it('forbids a viewer before deleting a template', async () => {
    const response = await DELETE(
      new Request(`http://localhost/api/whatsapp/templates/${TEMPLATE_ID}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: TEMPLATE_ID }) },
    )

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoProviderUse()
  })

  it('forbids a viewer before syncing templates from Meta', async () => {
    const response = await syncTemplates()

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expectNoProviderUse()
  })
})
