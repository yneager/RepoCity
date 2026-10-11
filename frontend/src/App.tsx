import { useEffect } from 'react'
import { BenchView } from './bench'
import { CityView } from './pages/CityView'
import { Home } from './pages/Home'
import { Progress } from './pages/Progress'
import { useRoute } from './router'
import { useCity } from './store'

export default function App() {
  const route = useRoute()
  const bench = /^#\/bench\/(\d+)/.exec(window.location.hash)
  useEffect(() => {
    if (route.page !== 'city') useCity.getState().reset()
  }, [route.page])
  if (bench) return <BenchView n={Number(bench[1])} />
  if (route.page === 'city') return <CityView id={route.id} />
  if (route.page === 'analyze') return <Progress id={route.id} />
  return <Home />
}
