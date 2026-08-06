import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getAccountEntitlement } from '@/lib/billing/account-entitlement'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Exact segment match — a plain startsWith('/entregadores') also
  // catches sibling routes that merely share the string prefix, like
  // /entregadores-manifest.webmanifest, which must stay publicly
  // fetchable (unauthenticated) for the driver PWA to be installable.
  const isEntregadoresPath = request.nextUrl.pathname === '/entregadores' || request.nextUrl.pathname.startsWith('/entregadores/')
  const isDriverPublic = request.nextUrl.pathname === '/entregadores/login' || request.nextUrl.pathname === '/entregadores/cadastro'
  if (!user && isEntregadoresPath && !isDriverPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/entregadores/login'
    url.search = ''
    return withRefreshedCookies(NextResponse.redirect(url))
  }
  if (user && !isEntregadoresPath && !request.nextUrl.pathname.startsWith('/api/driver/')) {
    if (user.user_metadata?.portal === 'driver') {
      const url = request.nextUrl.clone(); url.pathname = '/entregadores'; url.search = ''
      return withRefreshedCookies(NextResponse.redirect(url))
    }
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /today.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/today'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = [
    '/dashboard',
    '/today',
    '/tasks',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
    '/billing',
    '/orders',
    '/flows',
    '/notifications',
    '/agents',
    '/admin',
    '/drivers',
    '/execution',
  ]
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Billing gate — a signed-in user whose account has no valid
  // subscription (or whose payment lapsed) is confined to /billing.
  // Runs after the auth checks above so it only ever applies to a
  // resolved session. This remains an optimistic UX redirect: the
  // dashboard server layout and API authorization are authoritative.
  const billingExemptPaths = ['/billing', '/api/billing/']
  const isProtectedPath = protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))
  const isBillingExempt = billingExemptPaths.some(path => request.nextUrl.pathname.startsWith(path))
  if (user && isProtectedPath && !isBillingExempt) {
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (profileRow?.account_id) {
      const entitlement = await getAccountEntitlement(
        supabase,
        profileRow.account_id,
      )

      if (!entitlement.hasAccess) {
        const url = request.nextUrl.clone()
        url.pathname = '/billing'
        url.search = ''
        return withRefreshedCookies(NextResponse.redirect(url))
      }
    }
  }

  // API routes that need auth (not webhooks). Both `/api/whatsapp/
  // webhook` (Meta, HMAC-signed) and `/api/whatsapp/worker-webhook`
  // (Baileys worker, bearer-secret) self-authenticate without a user
  // session — match on "webhook" without a leading slash so the
  // latter (no "/" before "webhook") is exempted too.
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
