import { useEffect, useState } from 'react'

export type Route = { page: 'home' } | { page: 'analyze'; id: string } | { page: 'city'; id: string }

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 'city' && parts[1]) return { page: 'city', id: parts[1] }
  if (parts[0] === 'analyze' && parts[1]) return { page: 'analyze', id: parts[1] }
  return { page: 'home' }
}

export function navigate(route: Route): void {
  window.location.hash = route.page === 'home' ? '#/' : `#/${route.page}/${encodeURIComponent(route.id)}`
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash))
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
