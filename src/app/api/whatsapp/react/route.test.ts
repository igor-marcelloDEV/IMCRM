import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  sendReactionMessage: vi.fn(),
  decrypt: vi.fn(),
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

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendReactionMessage: mocks.sendReactionMessage,
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mocks.decrypt,
}))

import { POST } from './route'

describe('POST /api/whatsapp/react — authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRole.mockRejectedValue(
      Object.assign(new Error('Esta ação requer a função agent ou superior'), {
        status: 403,
      }),
    )
  })

  it('forbids a viewer before decrypting credentials or calling Meta', async () => {
    const response = await POST(
      new Request('http://localhost/api/whatsapp/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: 'message-1', emoji: '👍' }),
      }),
    )

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(mocks.decrypt).not.toHaveBeenCalled()
    expect(mocks.sendReactionMessage).not.toHaveBeenCalled()
  })
})
